"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");

// Resolve the Space Haven save root. Order:
//   1. SPACE_HAVEN_SAVE_DIR env var
//   2. Steam install default on Windows: %USERPROFILE%/AppData/Roaming/spacehaven
//   3. macOS default: ~/Library/Application Support/spacehaven
//   4. Linux default: ~/.config/spacehaven
// Look for an autosave subfolder; if missing, see if `dir` is a "savegames"
// folder containing one or more world subfolders, and pick the most recently
// modified one. Returns the resolved folder (or `dir` unchanged if no descent
// applies).
function maybeDescendToWorld(dir) {
  if (!fs.existsSync(dir)) return dir;
  // If this directory already contains an autosave or save subfolder we're
  // good — it IS a world folder.
  for (const name of ["autosave1", "autosave2", "autosave3", "autosave4", "save"]) {
    if (fs.existsSync(path.join(dir, name))) return dir;
  }
  // Otherwise look one level down for a world folder.
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return dir; }
  const worlds = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .filter((p) => {
      // A world folder contains at least one autosave or a `save` folder.
      for (const name of ["autosave1", "autosave2", "autosave3", "autosave4", "save"]) {
        if (fs.existsSync(path.join(p, name))) return true;
      }
      return false;
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return worlds[0] || dir;
}

function resolveSaveRoot() {
  const fromEnv = process.env.SPACE_HAVEN_SAVE_DIR;
  if (fromEnv) return maybeDescendToWorld(fromEnv);
  const home = os.homedir();
  const candidates = [
    path.join(home, "AppData", "Roaming", "spacehaven"),
    path.join(home, "Library", "Application Support", "spacehaven"),
    path.join(home, ".config", "spacehaven"),
    // Steam install on Windows ships saves under the game folder itself.
    // The dashboard reads any folder named "savegames/<world>/<slot>" but we
    // probe a couple of the most common Steam locations as a convenience.
    "C:/Program Files (x86)/Steam/steamapps/common/SpaceHaven/savegames",
    "C:/Program Files (x86)/st/steamapps/common/SpaceHaven/savegames",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return maybeDescendToWorld(c);
  }
  // Fall back to the first candidate even if missing; ingest will log a warning.
  return candidates[0];
}

const projectRoot = path.resolve(__dirname, "..");

module.exports = {
  saveRoot: resolveSaveRoot(),
  // Folders inside saveRoot that contain a `game` file we care about.
  saveFolders: ["autosave1", "autosave2", "autosave3", "autosave4", "save"],
  dbPath: path.join(projectRoot, "data", "history.db"),
  port: Number(process.env.PORT) || 4173,
  projectRoot,
};
