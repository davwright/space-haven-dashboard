"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");

// Resolve the Space Haven save root. Order:
//   1. SPACE_HAVEN_SAVE_DIR env var
//   2. Steam install default on Windows: %USERPROFILE%/AppData/Roaming/spacehaven
//   3. macOS default: ~/Library/Application Support/spacehaven
//   4. Linux default: ~/.config/spacehaven
function resolveSaveRoot() {
  if (process.env.SPACE_HAVEN_SAVE_DIR) return process.env.SPACE_HAVEN_SAVE_DIR;
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
    if (fs.existsSync(c)) return c;
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
