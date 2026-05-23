"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Use a temp DB so we don't touch the real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shd-test-"));
process.env.SPACE_HAVEN_SAVE_DIR = path.join(tmpDir, "saves");

// Override dbPath before requiring db.js
const realConfig = require("../src/config");
realConfig.dbPath = path.join(tmpDir, "history.db");

// Now require db (which uses realConfig.dbPath)
const db = require("../src/db");
const { ingestFolder } = require("../src/ingest");
const history = require("../src/history");

const FIX = path.join(__dirname, "fixtures");

test("ingestFolder inserts a new snapshot, dedups identical re-ingest", () => {
  const r1 = ingestFolder(path.join(FIX, "save-a"));
  assert.equal(r1.inserted, true);
  const r2 = ingestFolder(path.join(FIX, "save-a"));
  assert.equal(r2.inserted, false, "identical re-ingest deduped");
  assert.equal(r2.reason, "dedup");
});

test("ingestFolder inserts again when body set changes", () => {
  const r = ingestFolder(path.join(FIX, "save-b"));
  assert.equal(r.inserted, true);
  const days = history.listDays();
  assert.ok(days.length >= 2, "history grew");
});

test("history.snapshotForDay returns fog-of-war view including last-seen bodies", () => {
  // Ask for the latest day; we should see Newfound (only in save-b) AND
  // a fully-current view (all bodies have present=true).
  const days = history.listDays();
  const last = days[days.length - 1].game_day;
  const snap = history.snapshotForDay(last);
  assert.ok(snap, "snapshot returned");
  const ids = snap.bodies.map((b) => b.body_id);
  assert.ok(ids.includes("203"), "newly discovered body present at latest day");

  // Ask for an earlier day - should not include 203 (it didn't exist yet)
  const first = days[0].game_day;
  const earlier = history.snapshotForDay(first);
  const earlierIds = earlier.bodies.map((b) => b.body_id);
  assert.ok(!earlierIds.includes("203"), "future body not visible in past snapshot");
});

test("crewHistory returns one entry per cid with multi-day series", () => {
  const data = history.crewHistory();
  const alice = data.find((c) => c.cid === "9001");
  assert.ok(alice);
  assert.ok(alice.series.length >= 2, "Alice has at least 2 snapshots");
});

test.after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
