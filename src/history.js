"use strict";

// Read side of the history store. Builds the "fog of war" view: for any
// slider day, a body or ship is rendered if it was observed in the snapshot
// at that day OR in any earlier snapshot. Bodies seen earlier but not now
// are returned with a `lastSeenDay` so the UI can fade them.

const db = require("./db");
const { decorateCrew, decorateStorage } = require("./lookups");

function listDays() {
  return db
    .prepare("SELECT snapshot_id, game_day, real_timestamp FROM snapshots ORDER BY game_day ASC, snapshot_id ASC")
    .all();
}

function nearestSnapshotForDay(day) {
  return db
    .prepare(
      "SELECT snapshot_id, game_day, real_timestamp, save_path, player_ship_x, player_ship_y, player_system_id FROM snapshots WHERE game_day <= ? ORDER BY game_day DESC, snapshot_id DESC LIMIT 1"
    )
    .get(day);
}

function snapshotForDay(day) {
  const snap = nearestSnapshotForDay(day);
  if (!snap) return null;
  const full = fullSnapshot(snap.snapshot_id, snap.game_day);
  full.playerShipX = snap.player_ship_x;
  full.playerShipY = snap.player_ship_y;
  full.playerSystemId = snap.player_system_id;
  return full;
}

// Player ship galaxy positions across every snapshot, ordered by game_day.
function playerShipPath() {
  return db
    .prepare(
      `SELECT game_day, player_ship_x AS x, player_ship_y AS y, player_system_id AS system_id
         FROM snapshots
        WHERE player_ship_x IS NOT NULL AND player_ship_y IS NOT NULL
        ORDER BY game_day ASC, snapshot_id ASC`
    )
    .all();
}

function fullSnapshot(snapshotId, gameDay) {
  // Bodies in this exact snapshot
  const currentBodies = db
    .prepare(
      "SELECT body_id, x, y, type, name, visited, saved, system_id, system_name, star_type, star_class, center_id FROM body_observations WHERE snapshot_id = ?"
    )
    .all(snapshotId);

  const currentIds = new Set(currentBodies.map((b) => b.body_id));

  // Last-seen lookup for bodies observed earlier but missing now
  const earlierRows = db
    .prepare(
      `SELECT bo.body_id, bo.x, bo.y, bo.type, bo.name, bo.visited, bo.saved,
              bo.system_id, bo.system_name, bo.star_type, bo.star_class, bo.center_id,
              MAX(s.game_day) AS last_seen_day
         FROM body_observations bo
         JOIN snapshots s ON s.snapshot_id = bo.snapshot_id
        WHERE s.game_day <= ?
        GROUP BY bo.body_id`
    )
    .all(gameDay);

  const bodies = [];
  for (const b of currentBodies) bodies.push({ ...b, present: true, lastSeenDay: gameDay });
  for (const e of earlierRows) {
    if (!currentIds.has(e.body_id)) {
      bodies.push({
        body_id: e.body_id,
        x: e.x,
        y: e.y,
        type: e.type,
        name: e.name,
        visited: e.visited,
        saved: e.saved,
        system_id: e.system_id,
        system_name: e.system_name,
        star_type: e.star_type,
        star_class: e.star_class,
        center_id: e.center_id,
        present: false,
        lastSeenDay: e.last_seen_day,
      });
    }
  }

  // Ships: collect every ship ever seen up to this day, with each observation
  // (so the UI can draw a path) and a "currently visible?" flag.
  const shipObservations = db
    .prepare(
      `SELECT so.ship_id, so.name, so.faction_id, so.x, so.y, so.system_id,
              s.game_day, s.snapshot_id
         FROM ship_observations so
         JOIN snapshots s ON s.snapshot_id = so.snapshot_id
        WHERE s.game_day <= ?
        ORDER BY so.ship_id, s.game_day ASC`
    )
    .all(gameDay);

  const shipsById = new Map();
  for (const row of shipObservations) {
    if (!shipsById.has(row.ship_id)) {
      shipsById.set(row.ship_id, {
        ship_id: row.ship_id,
        name: row.name,
        faction_id: row.faction_id,
        path: [],
        present: false,
        lastSeenDay: 0,
      });
    }
    const ship = shipsById.get(row.ship_id);
    ship.name = row.name ?? ship.name;
    ship.faction_id = row.faction_id ?? ship.faction_id;
    ship.path.push({
      day: row.game_day,
      x: row.x,
      y: row.y,
      system_id: row.system_id,
    });
    ship.lastSeenDay = Math.max(ship.lastSeenDay, row.game_day);
    if (row.snapshot_id === snapshotId) ship.present = true;
  }

  // Crew: each row's props_json is the FULL flat crew object. decorateCrew
  // tacks on human names from the library tables (or "#ID" placeholders if
  // the library hasn't been imported yet).
  const crew = db
    .prepare("SELECT cid, name, props_json FROM crew_snapshots WHERE snapshot_id = ?")
    .all(snapshotId)
    .map((c) => decorateCrew(safeJson(c.props_json) || { cid: c.cid, name: c.name }));

  const events = db
    .prepare(
      "SELECT DISTINCT day, type, text FROM timeline_events WHERE day <= ? ORDER BY day ASC"
    )
    .all(gameDay);

  const storage = decorateStorage(
    db
      .prepare("SELECT elementary_id, count FROM storage_observations WHERE snapshot_id = ?")
      .all(snapshotId)
  );

  return {
    snapshotId,
    gameDay,
    bodies,
    ships: [...shipsById.values()],
    crew,
    events,
    storage,
  };
}

function crewHistory() {
  // For sparkline view: every crew snapshot grouped by cid, ordered by game_day.
  const rows = db
    .prepare(
      `SELECT cs.cid, cs.name, cs.props_json, s.game_day, s.snapshot_id
         FROM crew_snapshots cs
         JOIN snapshots s ON s.snapshot_id = cs.snapshot_id
        ORDER BY cs.cid, s.game_day ASC, s.snapshot_id ASC`
    )
    .all();
  const byCid = new Map();
  for (const r of rows) {
    if (!byCid.has(r.cid)) byCid.set(r.cid, { cid: r.cid, name: r.name, series: [] });
    const entry = byCid.get(r.cid);
    entry.name = r.name ?? entry.name;
    const props = safeJson(r.props_json) || {};
    entry.series.push({
      day: r.game_day,
      health: numOrNull(props.health),
      mood: numOrNull(props.mood),
      food: numOrNull(props.food),
      rest: numOrNull(props.rest),
      comfort: numOrNull(props.comfort),
      oxygen: numOrNull(props.oxygen),
    });
  }
  return [...byCid.values()];
}

function timelineTicks() {
  return db
    .prepare(
      "SELECT day, type, MIN(text) AS text FROM timeline_events GROUP BY day, type ORDER BY day ASC"
    )
    .all();
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  listDays,
  snapshotForDay,
  nearestSnapshotForDay,
  crewHistory,
  timelineTicks,
  playerShipPath,
};
