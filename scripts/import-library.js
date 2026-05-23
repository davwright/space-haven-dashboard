"use strict";

// Imports Space Haven's master game data (library/texts + library/haven) out
// of the player's spacehaven.jar into our SQLite history db so the dashboard
// can show real names ("Fatty acids deficiency") instead of numeric IDs
// (#2668). Bugbyte ships these files unencrypted inside the jar (a normal
// zip). We never redistribute their data; we only read it on the user's own
// machine from their own install.

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { XMLParser } = require("fast-xml-parser");

const db = require("../src/db");

const JAR_CANDIDATES = [
  process.env.SPACE_HAVEN_JAR_PATH,
  "C:/Program Files (x86)/st/steamapps/common/SpaceHaven/spacehaven.jar",
  "C:/Program Files/Steam/steamapps/common/SpaceHaven/spacehaven.jar",
  "C:/Program Files (x86)/Steam/steamapps/common/SpaceHaven/spacehaven.jar",
  path.join(os.homedir(), ".steam", "steam", "steamapps", "common", "SpaceHaven", "spacehaven.jar"),
  path.join(os.homedir(), "Library", "Application Support", "Steam", "steamapps", "common", "SpaceHaven", "spacehaven.jar"),
].filter(Boolean);

function findJar() {
  for (const c of JAR_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ---------- Minimal zip extractor -----------------------------------------
//
// We only need two entries (library/texts and library/haven) out of a known-
// good 184MB jar. The zip format is straightforward:
//   1. EOCD record at the END of the file, magic 0x06054b50.
//   2. EOCD points at the central directory.
//   3. Central directory entries (magic 0x02014b50) name every file and give
//      its compression method, sizes, and the offset of its local header.
//   4. Each local file header (magic 0x04034b50) is followed by the actual
//      file bytes (deflate or stored).
//
// Only methods 0 (stored) and 8 (deflate) are used by jar; we support both.

function findEocd(fd, fileSize) {
  // EOCD is at least 22 bytes, and the comment can be at most 65535 bytes.
  const scan = Math.min(fileSize, 22 + 65535);
  const buf = Buffer.alloc(scan);
  fs.readSync(fd, buf, 0, scan, fileSize - scan);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return {
        cdEntries: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error("zip EOCD not found");
}

function readCentralDirectory(fd, eocd) {
  const cd = Buffer.alloc(eocd.cdSize);
  fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset);
  const entries = [];
  let p = 0;
  for (let i = 0; i < eocd.cdEntries; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`bad central directory entry at offset ${p}`);
    }
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.slice(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(fd, entry) {
  // Read local file header to find the actual payload offset (its nameLen +
  // extraLen can differ from the central directory's).
  const lfh = Buffer.alloc(30);
  fs.readSync(fd, lfh, 0, 30, entry.localHeaderOffset);
  if (lfh.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`bad local header for ${entry.name}`);
  }
  const nameLen = lfh.readUInt16LE(26);
  const extraLen = lfh.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const compressed = Buffer.alloc(entry.compressedSize);
  fs.readSync(fd, compressed, 0, entry.compressedSize, dataStart);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

function extractFromJar(jarPath, names) {
  const fd = fs.openSync(jarPath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const eocd = findEocd(fd, fileSize);
    const entries = readCentralDirectory(fd, eocd);
    const result = {};
    for (const want of names) {
      const e = entries.find((x) => x.name === want);
      if (!e) throw new Error(`entry not found in jar: ${want}`);
      result[want] = readEntry(fd, e);
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- XML parsing ---------------------------------------------------

// fast-xml-parser exposes `jpath` (dotted path) to the isArray callback —
// we use it to discriminate the inner <t> list (jpath = "t.t") from the
// outer <t> root (jpath = "t"), and to leave the deeply-nested <l> lists
// inside haven entries alone (we explicitly array-ify only the few
// containers we actually read).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: true,
  isArray: (name, jpath) => {
    if (jpath === "t.t") return true;
    if (jpath === "data.CharacterCondition.condition") return true;
    if (jpath === "data.CharacterTrait.trait") return true;
    if (jpath === "data.Product.product") return true;
    if (jpath === "data.Faction.faction") return true;
    if (jpath === "data.PersonalitySettings.settings") return true;
    if (jpath === "data.PersonalitySettings.settings.attributes.l") return true;
    return false;
  },
});

const LANG_TAGS = ["EN", "DE", "FR", "ES", "IT", "PL", "CN", "CS", "JA", "KO", "PTBR", "RU", "TR"];

function parseTexts(xmlBuf) {
  const doc = parser.parse(xmlBuf.toString("utf8"));
  // doc.t is the root <t>, doc.t.t is the always-array list of entries.
  const items = doc.t.t;
  const out = [];
  for (const t of items) {
    if (t["@_id"] == null) continue;
    const row = {
      tid: Number(t["@_id"]),
      pid: t["@_pid"] != null ? Number(t["@_pid"]) : null,
    };
    for (const lang of LANG_TAGS) {
      const v = t[lang];
      row[lang.toLowerCase()] = v == null ? null : String(v);
    }
    out.push(row);
  }
  return out;
}

function parseHaven(xmlBuf) {
  const doc = parser.parse(xmlBuf.toString("utf8"));
  const data = doc.data;
  const libVersion = data["@_libVersion"] || null;

  const conditions = [];
  const condList = data.CharacterCondition?.condition || [];
  for (const c of condList) {
    conditions.push({
      id: Number(c["@_id"]),
      name_tid: c.name?.["@_tid"] != null ? Number(c.name["@_tid"]) : null,
      desc_tid: c.desc?.["@_tid"] != null ? Number(c.desc["@_tid"]) : null,
      color: c["@_color"] != null ? String(c["@_color"]) : null,
      meta: c["@_meta"] != null ? String(c["@_meta"]) : null,
      stackable: c["@_stackable"] === true || c["@_stackable"] === "true" ? 1 : 0,
      only_one: c["@_onlyOne"] === true || c["@_onlyOne"] === "true" ? 1 : 0,
      display_on_screen: c["@_displayOnScreen"] === true || c["@_displayOnScreen"] === "true" ? 1 : 0,
      add_to_log: c["@_addToLog"] === true || c["@_addToLog"] === "true" ? 1 : 0,
    });
  }

  const traits = [];
  const traitList = data.CharacterTrait?.trait || [];
  for (const t of traitList) {
    if (t["@_id"] == null) continue;
    traits.push({
      id: Number(t["@_id"]),
      name_tid: t.name?.["@_tid"] != null ? Number(t.name["@_tid"]) : null,
      desc_tid: t.desc?.["@_tid"] != null ? Number(t.desc["@_tid"]) : null,
    });
  }

  // Inventory items: <Product><product eid="..." type="Elementary" ...>.
  // Crops also live here (type="Crop") and saves reference both flavours via
  // elementaryId, so we capture all products that have a name tid.
  const elements = [];
  const prodList = data.Product?.product || [];
  for (const p of prodList) {
    if (p["@_eid"] == null) continue;
    const nameTid = p.name?.["@_tid"];
    if (nameTid == null) continue;
    elements.push({
      id: Number(p["@_eid"]),
      name_tid: Number(nameTid),
      desc_tid: p.desc?.["@_tid"] != null ? Number(p.desc["@_tid"]) : null,
      type: p["@_type"] != null ? String(p["@_type"]) : null,
    });
  }

  // Attributes: the 4 character attributes (Bravery / Zest / Intelligence /
  // Perception) live inside PersonalitySettings/settings[id=188]/attributes
  // as <l at=N type=Name name tid=TID>. Saves reference them by tid directly
  // (the save's <a id="210"> matches text tid=210 = "Bravery").
  const attributes = [];
  const settingsList = data.PersonalitySettings?.settings || [];
  const seenAttrTids = new Set();
  for (const s of settingsList) {
    const attrL = s.attributes?.l || [];
    for (const a of attrL) {
      const tid = a.name?.["@_tid"];
      if (tid == null) continue;
      const tidNum = Number(tid);
      if (seenAttrTids.has(tidNum)) continue;
      seenAttrTids.add(tidNum);
      attributes.push({
        id: tidNum,
        name_tid: tidNum,
        desc_tid: a.desc?.["@_tid"] != null ? Number(a.desc["@_tid"]) : null,
      });
    }
  }

  // Factions: <Faction><faction id=... <name tid=.../>>.
  const factions = [];
  const factionList = data.Faction?.faction || [];
  for (const f of factionList) {
    if (f["@_id"] == null) continue;
    const nameTid = f.name?.["@_tid"];
    factions.push({
      id: Number(f["@_id"]),
      name_tid: nameTid != null ? Number(nameTid) : null,
      side: f["@_side"] != null ? String(f["@_side"]) : null,
    });
  }

  return { libVersion, conditions, traits, elements, attributes, factions };
}

// ---------- DB schema -----------------------------------------------------

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lib_version TEXT,
      jar_mtime INTEGER,
      imported_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS text_defs (
      tid INTEGER PRIMARY KEY,
      pid INTEGER,
      en TEXT, de TEXT, fr TEXT, es TEXT, it TEXT,
      pl TEXT, cn TEXT, cs TEXT, ja TEXT, ko TEXT,
      ptbr TEXT, ru TEXT, tr TEXT
    );
    CREATE TABLE IF NOT EXISTS condition_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER, desc_tid INTEGER,
      color TEXT, meta TEXT, stackable INTEGER,
      only_one INTEGER, display_on_screen INTEGER, add_to_log INTEGER
    );
    CREATE TABLE IF NOT EXISTS trait_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER, desc_tid INTEGER
    );
    CREATE TABLE IF NOT EXISTS element_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER, desc_tid INTEGER,
      type TEXT
    );
    CREATE TABLE IF NOT EXISTS attribute_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER, desc_tid INTEGER
    );
    CREATE TABLE IF NOT EXISTS faction_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER, side TEXT
    );
  `);
}

// ---------- Top-level import ---------------------------------------------

function importLibrary(jarPath) {
  ensureSchema();
  const jarStat = fs.statSync(jarPath);
  console.log(`[import-library] reading ${jarPath}`);
  console.log(`[import-library] jar mtime: ${new Date(jarStat.mtimeMs).toISOString()}`);

  const t0 = Date.now();
  const entries = extractFromJar(jarPath, ["library/texts", "library/haven"]);
  console.log(`[import-library] extracted ${entries["library/texts"].length} bytes texts, ${entries["library/haven"].length} bytes haven (${Date.now() - t0}ms)`);

  console.log("[import-library] parsing texts XML...");
  const t1 = Date.now();
  const texts = parseTexts(entries["library/texts"]);
  console.log(`[import-library] parsed ${texts.length} text entries (${Date.now() - t1}ms)`);

  console.log("[import-library] parsing haven XML...");
  const t2 = Date.now();
  const haven = parseHaven(entries["library/haven"]);
  console.log(`[import-library] parsed haven (${Date.now() - t2}ms): libVersion=${haven.libVersion}, ${haven.conditions.length} conditions, ${haven.traits.length} traits, ${haven.elements.length} elements, ${haven.attributes.length} attributes, ${haven.factions.length} factions`);

  // Wipe and reload — we want fresh data on every import.
  const insertTexts = db.prepare(
    "INSERT INTO text_defs (tid, pid, en, de, fr, es, it, pl, cn, cs, ja, ko, ptbr, ru, tr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertCondition = db.prepare(
    "INSERT INTO condition_defs (id, name_tid, desc_tid, color, meta, stackable, only_one, display_on_screen, add_to_log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertTrait = db.prepare("INSERT INTO trait_defs (id, name_tid, desc_tid) VALUES (?, ?, ?)");
  const insertElement = db.prepare("INSERT INTO element_defs (id, name_tid, desc_tid, type) VALUES (?, ?, ?, ?)");
  const insertAttr = db.prepare("INSERT INTO attribute_defs (id, name_tid, desc_tid) VALUES (?, ?, ?)");
  const insertFaction = db.prepare("INSERT INTO faction_defs (id, name_tid, side) VALUES (?, ?, ?)");
  const upsertVersion = db.prepare(
    "INSERT OR REPLACE INTO library_version (id, lib_version, jar_mtime, imported_at) VALUES (1, ?, ?, ?)"
  );

  const writeAll = db.transaction(() => {
    db.exec("DELETE FROM text_defs; DELETE FROM condition_defs; DELETE FROM trait_defs; DELETE FROM element_defs; DELETE FROM attribute_defs; DELETE FROM faction_defs;");
    for (const t of texts) {
      insertTexts.run(t.tid, t.pid, t.en, t.de, t.fr, t.es, t.it, t.pl, t.cn, t.cs, t.ja, t.ko, t.ptbr, t.ru, t.tr);
    }
    for (const c of haven.conditions) {
      insertCondition.run(c.id, c.name_tid, c.desc_tid, c.color, c.meta, c.stackable, c.only_one, c.display_on_screen, c.add_to_log);
    }
    for (const t of haven.traits) insertTrait.run(t.id, t.name_tid, t.desc_tid);
    for (const e of haven.elements) insertElement.run(e.id, e.name_tid, e.desc_tid, e.type);
    for (const a of haven.attributes) insertAttr.run(a.id, a.name_tid, a.desc_tid);
    for (const f of haven.factions) insertFaction.run(f.id, f.name_tid, f.side);
    upsertVersion.run(haven.libVersion, Math.floor(jarStat.mtimeMs), Date.now());
  });

  writeAll();

  const dateStr = new Date(jarStat.mtimeMs).toISOString().slice(0, 10);
  console.log(
    `[import-library] Imported ${texts.length} text entries, ${haven.conditions.length} conditions, ${haven.traits.length} traits, ${haven.elements.length} elements, ${haven.attributes.length} attributes, ${haven.factions.length} factions from libVersion ${haven.libVersion} (jar from ${dateStr}).`
  );

  return {
    libVersion: haven.libVersion,
    jarMtime: jarStat.mtimeMs,
    counts: {
      texts: texts.length,
      conditions: haven.conditions.length,
      traits: haven.traits.length,
      elements: haven.elements.length,
      attributes: haven.attributes.length,
      factions: haven.factions.length,
    },
  };
}

function needsImport(jarPath) {
  ensureSchema();
  const row = db.prepare("SELECT lib_version, jar_mtime FROM library_version WHERE id = 1").get();
  if (!row) return { needed: true, reason: "library not yet imported" };
  if (!jarPath || !fs.existsSync(jarPath)) return { needed: false, reason: "no jar to compare against" };
  const mtime = Math.floor(fs.statSync(jarPath).mtimeMs);
  if (mtime > (row.jar_mtime || 0)) return { needed: true, reason: `jar updated (mtime ${mtime} > ${row.jar_mtime})` };
  return { needed: false, reason: "up to date" };
}

function main() {
  const jar = findJar();
  if (!jar) {
    console.error("Could not find spacehaven.jar. Set SPACE_HAVEN_JAR_PATH env var to point at it.");
    process.exit(1);
  }
  importLibrary(jar);
}

if (require.main === module) main();

module.exports = { importLibrary, findJar, needsImport };
