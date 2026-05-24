"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { backfillAll } = require("./ingest");
const watcher = require("./watcher");
const history = require("./history");
const { port, projectRoot, saveRoot } = require("./config");
const { importLibrary, findJar, needsImport } = require("../scripts/import-library");

const sseClients = new Set();

function sendSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res) {
  const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = path.join(projectRoot, "public", url);
  if (!file.startsWith(path.join(projectRoot, "public"))) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "content-type": mime[ext] || "application/octet-stream" });
    res.end(buf);
  });
}

function jsonRes(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ saveRoot })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/history/days") {
    return jsonRes(res, 200, history.listDays());
  }

  if (pathname.startsWith("/history/snapshot/")) {
    const day = Number(pathname.slice("/history/snapshot/".length));
    if (!Number.isFinite(day)) return jsonRes(res, 400, { error: "bad day" });
    const snap = history.snapshotForDay(day);
    if (!snap) return jsonRes(res, 404, { error: "no snapshot at or before day", day });
    return jsonRes(res, 200, snap);
  }

  if (pathname === "/history/crew") {
    return jsonRes(res, 200, history.crewHistory());
  }

  if (pathname === "/history/timeline-ticks") {
    return jsonRes(res, 200, history.timelineTicks());
  }

  if (pathname === "/history/player-path") {
    return jsonRes(res, 200, history.playerShipPath());
  }

  if (pathname === "/status") {
    const days = history.listDays();
    return jsonRes(res, 200, {
      saveRoot,
      snapshots: days.length,
      firstDay: days[0]?.game_day ?? null,
      lastDay: days[days.length - 1]?.game_day ?? null,
    });
  }

  if (req.method === "GET") return serveStatic(req, res);

  res.writeHead(404).end("not found");
});

function maybeImportLibrary() {
  const jar = findJar();
  if (!jar) {
    console.warn(
      "[server] spacehaven.jar not found — dashboard will show numeric IDs (#1582 etc) instead of names. Set SPACE_HAVEN_JAR_PATH to fix."
    );
    return;
  }
  const status = needsImport(jar);
  if (!status.needed) {
    console.log(`[server] library up to date (${status.reason})`);
    return;
  }
  console.log(`[server] importing game library from ${jar} (${status.reason})...`);
  try {
    importLibrary(jar);
  } catch (err) {
    console.error("[server] library import failed:", err.message);
    console.error("[server] continuing without name lookups");
  }
}

function main() {
  console.log(`[server] save root: ${saveRoot}`);
  maybeImportLibrary();
  console.log("[server] running initial backfill...");
  const results = backfillAll();
  const inserted = results.filter((r) => r.inserted).length;
  console.log(`[server] backfill complete: ${inserted}/${results.length} new snapshots`);

  watcher.start((result) => {
    console.log(`[server] new snapshot ${result.snapshotId}`);
    sendSse("snapshot", { snapshotId: result.snapshotId });
  });

  server.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
  });
}

if (require.main === module) main();

module.exports = { server };
