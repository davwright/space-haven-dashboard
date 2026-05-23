"use strict";

const path = require("path");
const fs = require("fs");
const chokidar = require("chokidar");
const { saveRoot, saveFolders } = require("./config");
const { ingestFolder } = require("./ingest");

function start(onSnapshot) {
  const targets = saveFolders.map((n) => path.join(saveRoot, n, "game"));
  // chokidar tolerates non-existent paths and will fire when they appear.
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
  });
  const handle = (file) => {
    const folder = path.dirname(file);
    try {
      const result = ingestFolder(folder);
      if (result.inserted && onSnapshot) onSnapshot(result);
    } catch (err) {
      console.error(`[watcher] ingest failed ${folder}:`, err.message);
    }
  };
  watcher.on("add", handle);
  watcher.on("change", handle);
  return watcher;
}

module.exports = { start };
