"use strict";

// Read side of the history store. Builds the "fog of war" view: for any
// slider day, a body or ship is rendered if it was observed in the snapshot
// at that day OR in any earlier snapshot. Bodies seen earlier but not now
// are returned with a `lastSeenDay` so the UI can fade them.

const db = require("./db");
const { decorateCrew, decorateStorage, elementInfo, FERTILITY_ELEMENT_IDS } = require("./lookups");

function listDays() {
  return db
    .prepare("SELECT snapshot_id, game_day, real_timestamp FROM snapshots ORDER BY game_day ASC, snapshot_id ASC")
    .all();
}

function nearestSnapshotForDay(day) {
  return db
    .prepare(
      "SELECT snapshot_id, game_day, real_timestamp, save_path, player_ship_x, player_ship_y, player_system_id, jump_edges_json, recipe_ratios_json, corpses, researched_tech_json, research_progress_json FROM snapshots WHERE game_day <= ? ORDER BY game_day DESC, snapshot_id DESC LIMIT 1"
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
  full.jumpEdges = snap.jump_edges_json ? safeJson(snap.jump_edges_json) || [] : [];
  full.recipeRatios = snap.recipe_ratios_json ? safeJson(snap.recipe_ratios_json) || {} : {};
  full.researchedTech = snap.researched_tech_json ? safeJson(snap.researched_tech_json) || [] : [];
  full.researchProgress = snap.research_progress_json ? safeJson(snap.research_progress_json) || {} : {};
  full.fertility = buildFertility(full.storage, snap.corpses || 0);
  return full;
}

// Surface compost/fertilizer/bio matter from the storage list (we already
// have decorated rows with elementary_id), plus the live corpse count.
function buildFertility(storage, corpses) {
  const byEid = new Map();
  for (const s of storage || []) byEid.set(String(s.elementary_id), s.count || 0);
  return {
    bioMatter: byEid.get(String(FERTILITY_ELEMENT_IDS.bioMatter)) || 0,
    fertilizer: byEid.get(String(FERTILITY_ELEMENT_IDS.fertilizer)) || 0,
    // No standalone Compost item — composter produces Fertilizer. We mirror
    // the fertilizer count here so the UI's "Compost:" label has a number.
    compost: byEid.get(String(FERTILITY_ELEMENT_IDS.fertilizer)) || 0,
    corpses,
  };
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
      "SELECT body_id, x, y, type, name, visited, saved, system_id, system_name, star_type, star_class, center_id, stuff_json, scannable FROM body_observations WHERE snapshot_id = ?"
    )
    .all(snapshotId);

  const currentIds = new Set(currentBodies.map((b) => b.body_id));

  // Last-seen lookup for bodies observed earlier but missing now. For each
  // body we also pull the stuff_json from its latest observation, so the
  // "lastSeen" entries still show what was there when last visible.
  const earlierRows = db
    .prepare(
      `SELECT bo.body_id, bo.x, bo.y, bo.type, bo.name, bo.visited, bo.saved,
              bo.system_id, bo.system_name, bo.star_type, bo.star_class, bo.center_id,
              bo.stuff_json, bo.scannable,
              MAX(s.game_day) AS last_seen_day
         FROM body_observations bo
         JOIN snapshots s ON s.snapshot_id = bo.snapshot_id
        WHERE s.game_day <= ?
        GROUP BY bo.body_id`
    )
    .all(gameDay);

  const decorateStuff = (row) => ({
    ...row,
    // Bodies don't have their own names in Space Haven — only systems do.
    // The legacy `name` column ended up populated with system_name; suppress
    // it for non-stars so the map doesn't label every planet/moon/asteroid
    // with the system name redundantly. For Star bodies we keep it: the
    // star IS the system's named member.
    name: row.type === "Star" ? row.name : null,
    stuff: row.stuff_json ? safeJson(row.stuff_json) || [] : [],
    scannable: row.scannable ? 1 : 0,
    stuff_json: undefined, // hide the raw column from the API surface
  });

  const bodies = [];
  for (const b of currentBodies) bodies.push({ ...decorateStuff(b), present: true, lastSeenDay: gameDay });
  for (const e of earlierRows) {
    if (!currentIds.has(e.body_id)) {
      bodies.push({
        ...decorateStuff({
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
          stuff_json: e.stuff_json,
          scannable: e.scannable,
        }),
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

  // Grow beds: per-plant rows + per-crop aggregate. We resolve plant names
  // here from the library (saves don't carry names; the ingest just stored
  // the numeric crop element id).
  const growBedRows = (() => {
    try {
      return db
        .prepare(
          "SELECT plant_id, plant_name, growth, stage, bed_x, bed_y, ship_id FROM grow_bed_observations WHERE snapshot_id = ?"
        )
        .all(snapshotId);
    } catch {
      return [];
    }
  })();
  const growBeds = growBedRows.map((r) => ({
    plant_id: r.plant_id,
    plant_name: r.plant_name || elementInfo(r.plant_id).name,
    growth: r.growth,
    stage: r.stage,
    bed_x: r.bed_x,
    bed_y: r.bed_y,
    ship_id: r.ship_id,
  }));
  const cropAgg = {};
  for (const b of growBeds) {
    const key = String(b.plant_id);
    if (!cropAgg[key]) {
      cropAgg[key] = { name: b.plant_name, count: 0, totalGrowth: 0 };
    }
    cropAgg[key].count += 1;
    cropAgg[key].totalGrowth += b.growth || 0;
  }

  return {
    snapshotId,
    gameDay,
    bodies,
    ships: [...shipsById.values()],
    crew,
    events,
    storage,
    growBeds,
    crops: { byElement: cropAgg },
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

// Recipe API: each recipe with its inputs + outputs. Process products don't
// have their own <name tid> (they're transformations, not items), so we
// synthesise a label "Input → Output" from the resolved element names.
function listRecipes() {
  let recipes;
  try {
    recipes = db
      .prepare(
        `SELECT r.id, r.name, r.facility_type,
                r.out_protein, r.out_carbs, r.out_fat, r.out_vitamins, r.out_toxins
           FROM recipe_defs r`
      )
      .all();
  } catch {
    return []; // library not yet imported
  }
  if (recipes.length === 0) return [];
  const inputs = db
    .prepare(
      `SELECT ri.recipe_id, ri.element_id, ri.count, ri.consume_every,
              t.en AS name, e.type AS element_type
         FROM recipe_inputs ri
         LEFT JOIN element_defs e ON e.id = ri.element_id
         LEFT JOIN text_defs t ON t.tid = e.name_tid`
    )
    .all();
  const outputs = db
    .prepare(
      `SELECT ro.recipe_id, ro.element_id, ro.count, ro.produce_every,
              t.en AS name, e.type AS element_type,
              e.protein, e.carbs, e.fat, e.vitamins, e.toxins
         FROM recipe_outputs ro
         LEFT JOIN element_defs e ON e.id = ro.element_id
         LEFT JOIN text_defs t ON t.tid = e.name_tid`
    )
    .all();
  const byId = new Map(recipes.map((r) => [r.id, {
    ...r,
    nutrition: (r.out_protein != null || r.out_carbs != null || r.out_fat != null || r.out_vitamins != null || r.out_toxins != null)
      ? {
          protein: r.out_protein, carbs: r.out_carbs, fat: r.out_fat,
          vitamins: r.out_vitamins, toxins: r.out_toxins,
        }
      : null,
    inputs: [],
    outputs: [],
  }]));
  for (const i of inputs) {
    const r = byId.get(i.recipe_id);
    if (!r) continue;
    r.inputs.push({
      element_id: i.element_id,
      name: i.name || `Item #${i.element_id}`,
      type: i.element_type,
      count: i.count,
      consume_every: i.consume_every,
    });
  }
  for (const o of outputs) {
    const r = byId.get(o.recipe_id);
    if (!r) continue;
    const hasNut = o.protein != null || o.carbs != null || o.fat != null || o.vitamins != null || o.toxins != null;
    r.outputs.push({
      element_id: o.element_id,
      name: o.name || `Item #${o.element_id}`,
      type: o.element_type,
      count: o.count,
      produce_every: o.produce_every,
      nutrition: hasNut
        ? { protein: o.protein, carbs: o.carbs, fat: o.fat, vitamins: o.vitamins, toxins: o.toxins }
        : null,
    });
  }
  const all = [...byId.values()];
  for (const r of all) {
    if (r.name) continue;
    const ins = r.inputs.map((x) => x.name).join(" + ");
    const outs = r.outputs.map((x) => x.name).join(" + ");
    if (ins && outs) r.name = `${ins} → ${outs}`;
    else if (outs) r.name = `→ ${outs}`;
    else if (ins) r.name = `${ins} →`;
    else r.name = `Process #${r.id}`;
  }
  return all.sort((a, b) => {
    // Group by facility first, then by name.
    const fa = a.facility_type || "~";
    const fb = b.facility_type || "~";
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Tech defs + tree adjacency, joined with text_defs for readable names. Each
// tech carries `prerequisites` (incoming links: who must be researched first)
// and `unlocks` (outgoing links: what this tech enables next). Unlocks here
// are the *tree-graph* unlocks (downstream techs); the haven library's
// per-tech <unlocks> list (buildings/augmentations/etc) is separately
// captured as `gameUnlocks` so the capability layer can match them.
function listTechs() {
  let techs;
  try {
    techs = db
      .prepare(
        `SELECT id, name, category, cost, stage_count, hidden, unlocks_json
           FROM tech_defs`
      )
      .all();
  } catch {
    return [];
  }
  if (techs.length === 0) return [];
  const links = db
    .prepare("SELECT from_tech_id, to_tech_id FROM tech_tree_links")
    .all();
  const prereqs = new Map(); // tech -> [from ids]
  const downstream = new Map(); // tech -> [to ids]
  for (const l of links) {
    if (!prereqs.has(l.to_tech_id)) prereqs.set(l.to_tech_id, []);
    prereqs.get(l.to_tech_id).push(l.from_tech_id);
    if (!downstream.has(l.from_tech_id)) downstream.set(l.from_tech_id, []);
    downstream.get(l.from_tech_id).push(l.to_tech_id);
  }
  return techs.map((t) => ({
    id: t.id,
    name: t.name || `Tech #${t.id}`,
    category: t.category,
    cost: t.cost,
    stage_count: t.stage_count,
    hidden: !!t.hidden,
    prerequisites: prereqs.get(t.id) || [],
    unlocks: downstream.get(t.id) || [],
    gameUnlocks: t.unlocks_json ? safeJson(t.unlocks_json) || [] : [],
  }));
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
  listRecipes,
  listTechs,
};
