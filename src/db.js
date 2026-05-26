"use strict";

const path = require("path");
const fs = require("fs");
const { dbPath } = require("./config");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Prefer better-sqlite3 (specified in package.json) but fall back to the
// built-in node:sqlite on environments where the native module can't build
// (e.g. no Python toolchain). Both expose a near-identical sync API; we
// adapt the small differences here so the rest of the codebase doesn't care.
function openDatabase() {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch {
    // node:sqlite (built-in, Node 22+). API: exec(), prepare().run/.get/.all
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = ON");
    // Shim a minimal better-sqlite3 surface: .prepare, .exec, .transaction, .close
    const shim = {
      _raw: raw,
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const stmt = raw.prepare(sql);
        return {
          run: (...args) => {
            const r = stmt.run(...args);
            return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
          },
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
        };
      },
      transaction: (fn) => {
        return (arg) => {
          raw.exec("BEGIN");
          try {
            const result = fn(arg);
            raw.exec("COMMIT");
            return result;
          } catch (err) {
            raw.exec("ROLLBACK");
            throw err;
          }
        };
      },
      close: () => raw.close(),
    };
    return shim;
  }
}

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_day INTEGER NOT NULL,
    real_timestamp INTEGER NOT NULL,
    save_path TEXT NOT NULL,
    body_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_day ON snapshots(game_day);

  CREATE TABLE IF NOT EXISTS body_observations (
    snapshot_id INTEGER NOT NULL,
    body_id TEXT NOT NULL,
    x REAL,
    y REAL,
    type TEXT,
    name TEXT,
    visited INTEGER DEFAULT 0,
    saved INTEGER DEFAULT 0,
    PRIMARY KEY (snapshot_id, body_id),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ship_observations (
    snapshot_id INTEGER NOT NULL,
    ship_id TEXT NOT NULL,
    name TEXT,
    faction_id TEXT,
    x REAL,
    y REAL,
    system_id TEXT,
    PRIMARY KEY (snapshot_id, ship_id),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS crew_snapshots (
    snapshot_id INTEGER NOT NULL,
    cid TEXT NOT NULL,
    name TEXT,
    props_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, cid),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS timeline_events (
    snapshot_id INTEGER NOT NULL,
    day INTEGER NOT NULL,
    type INTEGER,
    text TEXT,
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_day ON timeline_events(day);

  CREATE TABLE IF NOT EXISTS storage_observations (
    snapshot_id INTEGER NOT NULL,
    elementary_id TEXT NOT NULL,
    count REAL,
    PRIMARY KEY (snapshot_id, elementary_id),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS grow_bed_observations (
    snapshot_id INTEGER NOT NULL,
    plant_id INTEGER NOT NULL,
    plant_name TEXT,
    growth REAL,
    stage TEXT,
    bed_x INTEGER NOT NULL,
    bed_y INTEGER NOT NULL,
    ship_id INTEGER,
    PRIMARY KEY (snapshot_id, bed_x, bed_y, ship_id),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
  );
`);

// Older databases may have a richer body_observations schema added; gracefully
// extend if columns are missing. SQLite ALTER TABLE only adds columns.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("body_observations", "system_id", "TEXT");
ensureColumn("body_observations", "system_name", "TEXT");
ensureColumn("body_observations", "star_type", "TEXT");
ensureColumn("body_observations", "star_class", "TEXT");
ensureColumn("body_observations", "center_id", "TEXT");

// Player ship galaxy position per snapshot (for the trail polyline + camera).
ensureColumn("snapshots", "player_ship_x", "INTEGER");
ensureColumn("snapshots", "player_ship_y", "INTEGER");
ensureColumn("snapshots", "player_system_id", "TEXT");

// Per-body in-game "what's here" cues: <stuff><s type="Derelict"/>… The list
// is stored as JSON so the frontend can render icons; the `scannable` mirror
// flag lets us SELECT WHERE scannable=1 without unpacking JSON.
ensureColumn("body_observations", "stuff_json", "TEXT");
ensureColumn("body_observations", "scannable", "INTEGER DEFAULT 0");

// Snapshot-level hyperspace jump graph (one row covers all edges for that
// snapshot). The shape rarely changes within a save, but a player-built
// hyperspace gate could add edges, so we still record per-snapshot.
ensureColumn("snapshots", "jump_edges_json", "TEXT");

// Per-recipe ingredient ratios tuned by the player in facility UIs (Kitchen
// sliders etc.). { [recipe_pid]: { pid, fpid, facility_mid, ratios: { eid:
// weight } } }. Stored as JSON so the shape can evolve without a migration.
ensureColumn("snapshots", "recipe_ratios_json", "TEXT");

// Count of dead entities (<e dead="1">) in the world at snapshot time. Used
// by the Fertility supply panel (corpses are composter input).
ensureColumn("snapshots", "corpses", "INTEGER DEFAULT 0");

// JSON array of completed tech ids (research fully unlocked) plus a JSON
// object of in-progress fractional progress per tech. Used by the capability
// gating layer's `{ type: "research", tech: "X" }` predicate.
ensureColumn("snapshots", "researched_tech_json", "TEXT");
ensureColumn("snapshots", "research_progress_json", "TEXT");

// ----- Insert interception ------------------------------------------------
//
// ingest.js is intentionally not edited here (parallel agent rules), but we
// still need to populate the new columns (body_observations.stuff_json,
// body_observations.scannable, snapshots.jump_edges_json) when ingest writes
// a snapshot. We intercept the two specific INSERT statements ingest prepares
// and, immediately after .run() succeeds, issue a follow-up UPDATE pulling
// the extras out of the side-channel map populated by parse-save.js.
//
// Identification is by literal SQL text — these statements come from ingest
// verbatim. If ingest's INSERT shape ever changes, the wrapper falls back to
// the unmodified statement (extras simply aren't applied). Verified against
// the day-56 real save 2026-05-26.

const INSERT_BODY_SQL =
  "INSERT INTO body_observations (snapshot_id, body_id, x, y, type, name, visited, saved, system_id, system_name, star_type, star_class, center_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_SNAPSHOT_SQL =
  "INSERT INTO snapshots (game_day, real_timestamp, save_path, body_hash, player_ship_x, player_ship_y, player_system_id) VALUES (?, ?, ?, ?, ?, ?, ?)";

const _rawPrepare = db.prepare.bind(db);
const _updateBodyExtras = _rawPrepare(
  "UPDATE body_observations SET stuff_json = ?, scannable = ? WHERE snapshot_id = ? AND body_id = ?"
);
const _updateSnapshotJumps = _rawPrepare(
  "UPDATE snapshots SET jump_edges_json = ? WHERE snapshot_id = ?"
);
const _updateSnapshotRecipes = _rawPrepare(
  "UPDATE snapshots SET recipe_ratios_json = ?, corpses = ? WHERE snapshot_id = ?"
);
const _updateSnapshotResearch = _rawPrepare(
  "UPDATE snapshots SET researched_tech_json = ?, research_progress_json = ? WHERE snapshot_id = ?"
);
const _insertGrowBed = _rawPrepare(
  "INSERT OR REPLACE INTO grow_bed_observations (snapshot_id, plant_id, plant_name, growth, stage, bed_x, bed_y, ship_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const _lookupSavePath = _rawPrepare("SELECT save_path FROM snapshots WHERE snapshot_id = ?");

function loadExtras() {
  // Lazy require to avoid a load-order issue: parse-save.js doesn't depend on
  // db.js, but server.js loads both and we can't rely on order.
  try {
    return require("./parse-save")._extras;
  } catch {
    return null;
  }
}

// ----- pid → recipe_id resolution -----------------------------------------
//
// The save's <prod pid="N"> uses a runtime-allocated unique id (sequential
// with surrounding entity ids — pid 850 sits between id 849 and id 851). That
// pid does NOT match haven's <product eid=N> for the Process recipe. To make
// the frontend able to match recipeRatios entries to /library/recipes rows,
// we resolve each save pid against the library at write-time:
//
//   1. Use the save's <food><n id="X"/> set (the engine's canonical ingredient
//      list for that prod) as the lookup key.
//   2. Match against recipe_inputs.element_id sets in the library.
//   3. If exactly one recipe matches, that's the resolved recipe_id.
//   4. If multiple match (e.g. two recipes share inputs but differ by
//      facility), surface them all — the frontend filters by facility_type.
//   5. If none match (recipe not in the library, e.g. some Bar variants), the
//      entry stays keyed by pid only.
//
// The output is the same shape as before but with a `recipe_id` field on each
// entry when resolved, AND the top-level object is keyed by recipe_id (when
// resolved) so the frontend's `recipeRatios[r.id]` lookup just works. Original
// pid is kept inside the entry for debugging.
function resolveRecipeRatios(ratios) {
  if (!ratios || typeof ratios !== "object") return ratios;
  let recipesByKey = null;
  try {
    const rows = _rawPrepare(
      "SELECT recipe_id, element_id FROM recipe_inputs ORDER BY recipe_id, element_id"
    ).all();
    recipesByKey = new Map();
    let curRid = null, curIns = [];
    const flush = () => {
      if (curRid == null || curIns.length === 0) return;
      const key = curIns.slice().sort((a, b) => a - b).join(",");
      if (!recipesByKey.has(key)) recipesByKey.set(key, []);
      recipesByKey.get(key).push(curRid);
    };
    for (const r of rows) {
      if (r.recipe_id !== curRid) { flush(); curRid = r.recipe_id; curIns = []; }
      curIns.push(r.element_id);
    }
    flush();
  } catch {
    return ratios; // library not imported yet
  }
  const out = {};
  for (const [pidKey, info] of Object.entries(ratios)) {
    const ingredients = info.food_elements && info.food_elements.length
      ? info.food_elements
      : Object.keys(info.ratios || {}).map(Number);
    const key = ingredients.slice().sort((a, b) => a - b).join(",");
    const candidates = recipesByKey.get(key) || [];
    const resolved = candidates.length === 1 ? candidates[0] : null;
    const entry = { ...info, recipe_id: resolved, candidate_recipe_ids: candidates };
    // Key the top-level map by recipe_id when uniquely resolved; otherwise
    // keep the pid. This makes the frontend's recipeRatios[r.id] lookup hit
    // for the common case (Kitchen Processed Food etc).
    out[resolved != null ? String(resolved) : pidKey] = entry;
  }
  return out;
}

db.prepare = function wrappedPrepare(sql) {
  const stmt = _rawPrepare(sql);
  if (sql === INSERT_BODY_SQL) {
    return {
      run: (...args) => {
        const r = stmt.run(...args);
        // args[0]=snapshot_id, args[1]=body_id. The body INSERT itself
        // doesn't carry save_path, so we look it up from the snapshots row
        // we just inserted in the same transaction. Cheap: PK lookup.
        const snapshotId = args[0];
        const bodyId = String(args[1]);
        try {
          const row = _lookupSavePath.get(snapshotId);
          const savePath = row ? row.save_path : null;
          if (savePath) {
            const payload = loadExtras()?.get(savePath);
            const bx = payload?.bodies?.get(bodyId);
            if (bx) _updateBodyExtras.run(bx.stuff_json, bx.scannable, snapshotId, bodyId);
          }
        } catch {
          // Best-effort: never break an ingest because extras are missing.
        }
        return r;
      },
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
    };
  }
  if (sql === INSERT_SNAPSHOT_SQL) {
    return {
      run: (...args) => {
        const r = stmt.run(...args);
        const savePath = args[2]; // matches the INSERT column order
        const snapshotId = r.lastInsertRowid;
        try {
          const payload = loadExtras()?.get(savePath);
          if (payload && payload.jump_edges_json) {
            _updateSnapshotJumps.run(payload.jump_edges_json, snapshotId);
          }
          if (payload && (payload.recipe_ratios_json || payload.corpses != null)) {
            // Re-key by resolved recipe_id where possible (see
            // resolveRecipeRatios above). Falls back to the pid-keyed shape if
            // the library isn't imported yet or no recipes match.
            let json = payload.recipe_ratios_json || null;
            if (json) {
              try {
                const resolved = resolveRecipeRatios(JSON.parse(json));
                json = JSON.stringify(resolved);
              } catch {
                // Bad JSON? Keep original.
              }
            }
            _updateSnapshotRecipes.run(json, payload.corpses || 0, snapshotId);
          }
          if (payload && (payload.researched_tech_json || payload.research_progress_json)) {
            _updateSnapshotResearch.run(
              payload.researched_tech_json || null,
              payload.research_progress_json || null,
              snapshotId
            );
          }
          if (payload && Array.isArray(payload.grow_beds)) {
            for (const gb of payload.grow_beds) {
              // Composite PK is (snapshot, bed_x, bed_y, ship_id). Skip rows
              // missing coordinates — we'd silently collapse them.
              if (gb.bed_x == null || gb.bed_y == null) continue;
              _insertGrowBed.run(
                snapshotId,
                gb.plant_id,
                gb.plant_name,
                gb.growth,
                gb.stage,
                gb.bed_x,
                gb.bed_y,
                gb.ship_id != null ? Number(gb.ship_id) : null
              );
            }
          }
        } catch {
          // Best-effort.
        }
        return r;
      },
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
    };
  }
  return stmt;
};

module.exports = db;
