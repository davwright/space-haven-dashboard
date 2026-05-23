"use strict";

// Smoke-test the server boot path and the read endpoints, end-to-end,
// against a temp save root containing our two fixture folders.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shd-smoke-"));
const saveRoot = path.join(tmpDir, "saves");
fs.mkdirSync(saveRoot, { recursive: true });

// Copy fixtures into "autosave1" and "save"
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(__dirname, "fixtures", "save-a"), path.join(saveRoot, "autosave1"));
copyDir(path.join(__dirname, "fixtures", "save-b"), path.join(saveRoot, "save"));

process.env.SPACE_HAVEN_SAVE_DIR = saveRoot;
process.env.PORT = "0";

const config = require("../src/config");
config.dbPath = path.join(tmpDir, "history.db");
config.saveRoot = saveRoot;

// Lazy require so config overrides take effect first
const { backfillAll } = require("../src/ingest");
const { server } = require("../src/server");

backfillAll();
server.listen(0);

function get(pathname) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

test("server: /status reports snapshot count", async () => {
  const r = await get("/status");
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(j.snapshots >= 2, `expected >=2 snapshots, got ${j.snapshots}`);
  assert.equal(j.firstDay, 2);
  assert.equal(j.lastDay, 4);
});

test("server: /history/days returns rows", async () => {
  const r = await get("/history/days");
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j) && j.length >= 2);
});

test("server: /history/snapshot/:day returns full fog-of-war state", async () => {
  const r = await get("/history/snapshot/4");
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.gameDay, 4);
  assert.ok(j.bodies.length >= 4);
  // ship 501 should appear (non-player), 500 should not (player)
  const shipIds = j.ships.map((s) => s.ship_id);
  assert.ok(shipIds.includes("501"));
  assert.ok(!shipIds.includes("500"));
});

test("server: /history/snapshot at earlier day excludes future bodies", async () => {
  const r = await get("/history/snapshot/2");
  const j = JSON.parse(r.body);
  const ids = j.bodies.map((b) => b.body_id);
  assert.ok(!ids.includes("203"), "Newfound not yet discovered on day 2");
});

test("server: /index.html served as static", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("Space Haven Dashboard"));
});

test.after(() => {
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
