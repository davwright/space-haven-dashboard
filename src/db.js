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

module.exports = db;
