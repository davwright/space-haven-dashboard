"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { parseSaveFolder } = require("./parse-save");
const { saveRoot, saveFolders } = require("./config");

function bodyHash(bodies) {
  const ids = bodies.map((b) => b.body_id).sort().join(",");
  return crypto.createHash("sha1").update(ids).digest("hex");
}

const stmtLatestSnapshot = db.prepare(
  "SELECT snapshot_id, game_day, body_hash FROM snapshots ORDER BY snapshot_id DESC LIMIT 1"
);
const stmtInsertSnapshot = db.prepare(
  "INSERT INTO snapshots (game_day, real_timestamp, save_path, body_hash, player_ship_x, player_ship_y, player_system_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const stmtInsertBody = db.prepare(
  "INSERT INTO body_observations (snapshot_id, body_id, x, y, type, name, visited, saved, system_id, system_name, star_type, star_class, center_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const stmtInsertStorage = db.prepare(
  "INSERT OR REPLACE INTO storage_observations (snapshot_id, elementary_id, count) VALUES (?, ?, ?)"
);
const stmtInsertShip = db.prepare(
  "INSERT INTO ship_observations (snapshot_id, ship_id, name, faction_id, x, y, system_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const stmtInsertCrew = db.prepare(
  "INSERT INTO crew_snapshots (snapshot_id, cid, name, props_json) VALUES (?, ?, ?, ?)"
);
const stmtInsertEvent = db.prepare(
  "INSERT INTO timeline_events (snapshot_id, day, type, text) VALUES (?, ?, ?, ?)"
);

const writeSnapshotTxn = db.transaction((parsed) => {
  const hash = bodyHash(parsed.bodies);
  const latest = stmtLatestSnapshot.get();
  if (latest && latest.game_day === parsed.gameDay && latest.body_hash === hash) {
    return { inserted: false, snapshotId: latest.snapshot_id, reason: "dedup" };
  }
  const info = stmtInsertSnapshot.run(
    parsed.gameDay,
    Date.now(),
    parsed.savePath,
    hash,
    parsed.playerShipX,
    parsed.playerShipY,
    parsed.playerSystemId
  );
  const snapshotId = info.lastInsertRowid;
  for (const b of parsed.bodies) {
    stmtInsertBody.run(
      snapshotId,
      b.body_id,
      b.x,
      b.y,
      b.type,
      b.system_name || null, // legacy "name" column repurposed as body label
      b.visited,
      b.saved,
      b.system_id,
      b.system_name,
      b.star_type,
      b.star_class,
      b.center_id
    );
  }
  for (const item of parsed.storage || []) {
    stmtInsertStorage.run(snapshotId, item.elementary_id, item.count);
  }
  for (const s of parsed.ships) {
    stmtInsertShip.run(snapshotId, s.ship_id, s.name, s.faction_id, s.x, s.y, s.system_id);
  }
  for (const c of parsed.crew) {
    // c is the flat crew object (health, mood, conditions[], skills[]…).
    // We snapshot everything as JSON; the history endpoint extracts the
    // top-level scalars for sparklines.
    stmtInsertCrew.run(snapshotId, c.cid, c.name, JSON.stringify(c));
  }
  for (const e of parsed.timelineEvents) {
    stmtInsertEvent.run(snapshotId, e.day, e.type, e.text);
  }
  return { inserted: true, snapshotId, reason: "new" };
});

function ingestFolder(folder) {
  const parsed = parseSaveFolder(folder);
  if (!parsed) return { inserted: false, reason: "no-game-file" };
  return writeSnapshotTxn(parsed);
}

function backfillAll() {
  const results = [];
  if (!fs.existsSync(saveRoot)) {
    console.warn(`[ingest] save root not found: ${saveRoot}`);
    return results;
  }
  // Sort folders by mtime ascending so history is built in chronological order.
  const candidates = saveFolders
    .map((name) => path.join(saveRoot, name))
    .filter((p) => fs.existsSync(path.join(p, "game")))
    .sort((a, b) => fs.statSync(path.join(a, "game")).mtimeMs - fs.statSync(path.join(b, "game")).mtimeMs);
  for (const folder of candidates) {
    try {
      const r = ingestFolder(folder);
      results.push({ folder, ...r });
    } catch (err) {
      console.error(`[ingest] failed ${folder}:`, err.message);
      results.push({ folder, inserted: false, reason: "error", error: err.message });
    }
  }
  return results;
}

module.exports = { ingestFolder, backfillAll };
