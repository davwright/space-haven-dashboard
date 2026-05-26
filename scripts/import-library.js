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
    if (jpath === "data.Product.product.needs.l") return true;
    if (jpath === "data.Product.product.products.l") return true;
    if (jpath === "data.Faction.faction") return true;
    if (jpath === "data.PersonalitySettings.settings") return true;
    if (jpath === "data.PersonalitySettings.settings.attributes.l") return true;
    if (jpath === "data.MainCat.cat") return true;
    if (jpath === "data.SubCat.cat") return true;
    if (jpath === "data.Element.me") return true;
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
  // Recipes (type="Process") also live here — captured separately below.
  const elements = [];
  const prodList = data.Product?.product || [];
  for (const p of prodList) {
    if (p["@_eid"] == null) continue;
    const nameTid = p.name?.["@_tid"];
    if (nameTid == null) continue;
    // <sort s="N" p="M"/> is the in-game storage group for inventory items.
    // s = group bucket (1=tools/energy, 2=food, 3=construction blocks,
    // 4=fabric/chemicals, 5=raw ores/ice, 6=gas/power); p = sort order within
    // the group. Verified against day-56 save 2026-05-26.
    const sortS = p.sort?.["@_s"] != null ? Number(p.sort["@_s"]) : null;
    const sortP = p.sort?.["@_p"] != null ? Number(p.sort["@_p"]) : null;
    // <edible foodUsageType="Food" protein="6.0" carbs="9.0" fat="4.0"
    //   vitamins="3.0" toxins="0.0" rank="10.0"/> on food items gives the
    // nutrient profile per unit. Same shape on <customFood> inside Process
    // recipes (captured separately below). Only food/beverage products have
    // <edible>; everything else gets null for these columns.
    const ed = p.edible;
    elements.push({
      id: Number(p["@_eid"]),
      name_tid: Number(nameTid),
      desc_tid: p.desc?.["@_tid"] != null ? Number(p.desc["@_tid"]) : null,
      type: p["@_type"] != null ? String(p["@_type"]) : null,
      sort_group: sortS,
      sort_pos: sortP,
      protein: ed?.["@_protein"] != null ? Number(ed["@_protein"]) : null,
      carbs: ed?.["@_carbs"] != null ? Number(ed["@_carbs"]) : null,
      fat: ed?.["@_fat"] != null ? Number(ed["@_fat"]) : null,
      vitamins: ed?.["@_vitamins"] != null ? Number(ed["@_vitamins"]) : null,
      toxins: ed?.["@_toxins"] != null ? Number(ed["@_toxins"]) : null,
    });
  }

  // MainCat / SubCat: build-menu categories. Each <MainCat><cat id name tid/>
  // is a top-level category (CREW / OBJECTS / etc.); each <SubCat><cat id
  // order parentMainCat name tid/> belongs to one MainCat. We resolve names
  // via the texts table denormalised below so reads don't need a JOIN.
  const mainCats = [];
  for (const c of data.MainCat?.cat || []) {
    if (c["@_id"] == null) continue;
    mainCats.push({
      id: Number(c["@_id"]),
      name_tid: c.name?.["@_tid"] != null ? Number(c.name["@_tid"]) : null,
      order: c["@_order"] != null ? Number(c["@_order"]) : null,
    });
  }
  const subCats = [];
  for (const c of data.SubCat?.cat || []) {
    if (c["@_id"] == null) continue;
    subCats.push({
      id: Number(c["@_id"]),
      parent_id: c.mainCat?.["@_id"] != null ? Number(c.mainCat["@_id"]) : null,
      name_tid: c.name?.["@_tid"] != null ? Number(c.name["@_tid"]) : null,
      order: c["@_order"] != null ? Number(c["@_order"]) : null,
    });
  }

  // <Element><me mid> entries are buildable map elements. Each has an
  // <objectInfo><subCat id/> that links it to a SubCat. We keep this so the
  // frontend can show what building category a placed structure belongs to.
  const buildElements = [];
  for (const me of data.Element?.me || []) {
    if (me["@_mid"] == null) continue;
    const oi = me.objectInfo;
    if (!oi) continue;
    const subId = oi.subCat?.["@_id"];
    if (subId == null) continue;
    buildElements.push({
      mid: Number(me["@_mid"]),
      sub_cat_id: Number(subId),
      name_tid: oi.name?.["@_tid"] != null ? Number(oi.name["@_tid"]) : null,
    });
  }

  // Recipes: every <product type="Process"> with at least one need or one
  // output. We capture inputs/outputs as separate rows and classify the
  // facility by the marker tags we see on the product:
  //   <foodProcessing>      Kitchen / Bar
  //   composter="true"      Composter
  //   smelter="true"        Smelter
  //   scrapper="true" or itemScrapper="true"  Scrapper
  //   <itemFab cat=>        Item Fabricator
  //   <difficulty skill=>   fallback hint
  // Verified against haven libVersion 1.0.1_steam_2 (2026-05-26).
  const recipes = [];
  const recipeInputs = [];
  const recipeOutputs = [];
  for (const p of prodList) {
    if (p["@_eid"] == null) continue;
    if (p["@_type"] !== "Process") continue;
    const needs = p.needs?.l || [];
    const outs = p.products?.l || [];
    if (needs.length === 0 && outs.length === 0) continue;
    const id = Number(p["@_eid"]);
    let facility = null;
    if (p.foodProcessing) {
      const usage = p.foodProcessing["@_foodUsageType"];
      facility = usage === "Beverage" ? "Bar" : "Kitchen";
    } else if (p["@_composter"] === true || p["@_composter"] === "true") {
      facility = "Composter";
    } else if (p["@_smelter"] === true || p["@_smelter"] === "true") {
      facility = "Smelter";
    } else if (p["@_itemScrapper"] === true || p["@_itemScrapper"] === "true" || p["@_scrapper"] === true || p["@_scrapper"] === "true") {
      facility = "Scrapper";
    } else if (p.itemFab) {
      facility = `ItemFab:${p.itemFab["@_cat"] || ""}`;
    } else if (p.difficulty?.["@_skill"] && p.difficulty["@_skill"] !== "None") {
      facility = p.difficulty["@_skill"];
    }
    const nameTid = p.name?.["@_tid"] != null ? Number(p.name["@_tid"]) : null;
    // <customFood protein= carbs= fat= vitamins= toxins=/> inside
    // <foodProcessing><dispenser> on Kitchen/Bar recipes gives the nutrient
    // profile of the FOOD this recipe produces (not necessarily the same as
    // the output element's own <edible> — recipes can tweak the profile).
    const cf = p.foodProcessing?.dispenser?.customFood;
    recipes.push({
      id,
      name_tid: nameTid,
      facility_type: facility,
      out_protein: cf?.["@_protein"] != null ? Number(cf["@_protein"]) : null,
      out_carbs: cf?.["@_carbs"] != null ? Number(cf["@_carbs"]) : null,
      out_fat: cf?.["@_fat"] != null ? Number(cf["@_fat"]) : null,
      out_vitamins: cf?.["@_vitamins"] != null ? Number(cf["@_vitamins"]) : null,
      out_toxins: cf?.["@_toxins"] != null ? Number(cf["@_toxins"]) : null,
    });
    for (const n of needs) {
      const el = n["@_element"];
      if (el == null) continue;
      recipeInputs.push({
        recipe_id: id,
        element_id: Number(el),
        count: n["@_howMuch"] != null ? Number(n["@_howMuch"]) : null,
        consume_every: n["@_consumeEvery"] != null ? Number(n["@_consumeEvery"]) : null,
      });
    }
    for (const o of outs) {
      const el = o["@_element"];
      if (el == null) continue;
      recipeOutputs.push({
        recipe_id: id,
        element_id: Number(el),
        count: o["@_howMuch"] != null ? Number(o["@_howMuch"]) : null,
        produce_every: o["@_produceEvery"] != null ? Number(o["@_produceEvery"]) : null,
      });
    }
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

  return {
    libVersion,
    conditions,
    traits,
    elements,
    attributes,
    factions,
    mainCats,
    subCats,
    buildElements,
    recipes,
    recipeInputs,
    recipeOutputs,
  };
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
      type TEXT,
      protein REAL, carbs REAL, fat REAL, vitamins REAL, toxins REAL
    );
    CREATE TABLE IF NOT EXISTS attribute_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER, desc_tid INTEGER
    );
    CREATE TABLE IF NOT EXISTS faction_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER, side TEXT
    );
    CREATE TABLE IF NOT EXISTS main_cat_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER,
      name TEXT,
      sort_order INTEGER
    );
    CREATE TABLE IF NOT EXISTS sub_cat_defs (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER,
      name_tid INTEGER,
      name TEXT,
      sort_order INTEGER
    );
    CREATE TABLE IF NOT EXISTS build_element_defs (
      mid INTEGER PRIMARY KEY,
      sub_cat_id INTEGER,
      name_tid INTEGER,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS recipe_defs (
      id INTEGER PRIMARY KEY,
      name_tid INTEGER,
      name TEXT,
      facility_type TEXT,
      out_protein REAL, out_carbs REAL, out_fat REAL, out_vitamins REAL, out_toxins REAL
    );
    CREATE TABLE IF NOT EXISTS recipe_inputs (
      recipe_id INTEGER NOT NULL,
      element_id INTEGER NOT NULL,
      count REAL,
      consume_every REAL,
      PRIMARY KEY (recipe_id, element_id)
    );
    CREATE TABLE IF NOT EXISTS recipe_outputs (
      recipe_id INTEGER NOT NULL,
      element_id INTEGER NOT NULL,
      count REAL,
      produce_every REAL,
      PRIMARY KEY (recipe_id, element_id)
    );
  `);

  // Older databases may have a leaner element_defs schema; extend if needed.
  ensureColumn("element_defs", "sort_group", "INTEGER");
  ensureColumn("element_defs", "sort_pos", "INTEGER");
  // Nutrient profile (per unit) for food/beverage products. NULL for non-food.
  ensureColumn("element_defs", "protein", "REAL");
  ensureColumn("element_defs", "carbs", "REAL");
  ensureColumn("element_defs", "fat", "REAL");
  ensureColumn("element_defs", "vitamins", "REAL");
  ensureColumn("element_defs", "toxins", "REAL");
  // Recipe output nutrient profile (from <customFood> on the Process product).
  ensureColumn("recipe_defs", "out_protein", "REAL");
  ensureColumn("recipe_defs", "out_carbs", "REAL");
  ensureColumn("recipe_defs", "out_fat", "REAL");
  ensureColumn("recipe_defs", "out_vitamins", "REAL");
  ensureColumn("recipe_defs", "out_toxins", "REAL");
}

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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
  console.log(`[import-library] parsed haven (${Date.now() - t2}ms): libVersion=${haven.libVersion}, ${haven.conditions.length} conditions, ${haven.traits.length} traits, ${haven.elements.length} elements, ${haven.attributes.length} attributes, ${haven.factions.length} factions, ${haven.mainCats.length} mainCats, ${haven.subCats.length} subCats, ${haven.buildElements.length} buildElements, ${haven.recipes.length} recipes (${haven.recipeInputs.length} inputs, ${haven.recipeOutputs.length} outputs)`);

  // Resolve tids → EN names so the new denormalized .name columns can be
  // populated in a single pass (avoid a JOIN on every read).
  const textByTid = new Map();
  for (const t of texts) textByTid.set(t.tid, t.en);
  const nameOf = (tid) => (tid != null ? textByTid.get(tid) ?? null : null);

  // Wipe and reload — we want fresh data on every import.
  const insertTexts = db.prepare(
    "INSERT INTO text_defs (tid, pid, en, de, fr, es, it, pl, cn, cs, ja, ko, ptbr, ru, tr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertCondition = db.prepare(
    "INSERT INTO condition_defs (id, name_tid, desc_tid, color, meta, stackable, only_one, display_on_screen, add_to_log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertTrait = db.prepare("INSERT INTO trait_defs (id, name_tid, desc_tid) VALUES (?, ?, ?)");
  const insertElement = db.prepare(
    "INSERT INTO element_defs (id, name_tid, desc_tid, type, sort_group, sort_pos, protein, carbs, fat, vitamins, toxins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertAttr = db.prepare("INSERT INTO attribute_defs (id, name_tid, desc_tid) VALUES (?, ?, ?)");
  const insertFaction = db.prepare("INSERT INTO faction_defs (id, name_tid, side) VALUES (?, ?, ?)");
  const insertMainCat = db.prepare("INSERT INTO main_cat_defs (id, name_tid, name, sort_order) VALUES (?, ?, ?, ?)");
  const insertSubCat = db.prepare("INSERT INTO sub_cat_defs (id, parent_id, name_tid, name, sort_order) VALUES (?, ?, ?, ?, ?)");
  const insertBuildElement = db.prepare("INSERT OR REPLACE INTO build_element_defs (mid, sub_cat_id, name_tid, name) VALUES (?, ?, ?, ?)");
  const insertRecipe = db.prepare(
    "INSERT INTO recipe_defs (id, name_tid, name, facility_type, out_protein, out_carbs, out_fat, out_vitamins, out_toxins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertRecipeIn = db.prepare("INSERT OR REPLACE INTO recipe_inputs (recipe_id, element_id, count, consume_every) VALUES (?, ?, ?, ?)");
  const insertRecipeOut = db.prepare("INSERT OR REPLACE INTO recipe_outputs (recipe_id, element_id, count, produce_every) VALUES (?, ?, ?, ?)");
  const upsertVersion = db.prepare(
    "INSERT OR REPLACE INTO library_version (id, lib_version, jar_mtime, imported_at) VALUES (1, ?, ?, ?)"
  );

  const writeAll = db.transaction(() => {
    db.exec(
      "DELETE FROM text_defs; DELETE FROM condition_defs; DELETE FROM trait_defs;" +
        " DELETE FROM element_defs; DELETE FROM attribute_defs; DELETE FROM faction_defs;" +
        " DELETE FROM main_cat_defs; DELETE FROM sub_cat_defs; DELETE FROM build_element_defs;" +
        " DELETE FROM recipe_defs; DELETE FROM recipe_inputs; DELETE FROM recipe_outputs;"
    );
    for (const t of texts) {
      insertTexts.run(t.tid, t.pid, t.en, t.de, t.fr, t.es, t.it, t.pl, t.cn, t.cs, t.ja, t.ko, t.ptbr, t.ru, t.tr);
    }
    for (const c of haven.conditions) {
      insertCondition.run(c.id, c.name_tid, c.desc_tid, c.color, c.meta, c.stackable, c.only_one, c.display_on_screen, c.add_to_log);
    }
    for (const t of haven.traits) insertTrait.run(t.id, t.name_tid, t.desc_tid);
    for (const e of haven.elements) insertElement.run(
      e.id, e.name_tid, e.desc_tid, e.type, e.sort_group, e.sort_pos,
      e.protein, e.carbs, e.fat, e.vitamins, e.toxins
    );
    for (const a of haven.attributes) insertAttr.run(a.id, a.name_tid, a.desc_tid);
    for (const f of haven.factions) insertFaction.run(f.id, f.name_tid, f.side);
    for (const mc of haven.mainCats) insertMainCat.run(mc.id, mc.name_tid, nameOf(mc.name_tid), mc.order);
    for (const sc of haven.subCats) insertSubCat.run(sc.id, sc.parent_id, sc.name_tid, nameOf(sc.name_tid), sc.order);
    for (const be of haven.buildElements) insertBuildElement.run(be.mid, be.sub_cat_id, be.name_tid, nameOf(be.name_tid));
    for (const r of haven.recipes) insertRecipe.run(
      r.id, r.name_tid, nameOf(r.name_tid), r.facility_type,
      r.out_protein, r.out_carbs, r.out_fat, r.out_vitamins, r.out_toxins
    );
    for (const ri of haven.recipeInputs) insertRecipeIn.run(ri.recipe_id, ri.element_id, ri.count, ri.consume_every);
    for (const ro of haven.recipeOutputs) insertRecipeOut.run(ro.recipe_id, ro.element_id, ro.count, ro.produce_every);
    upsertVersion.run(haven.libVersion, Math.floor(jarStat.mtimeMs), Date.now());
  });

  writeAll();

  const dateStr = new Date(jarStat.mtimeMs).toISOString().slice(0, 10);
  console.log(
    `[import-library] Imported ${texts.length} text entries, ${haven.conditions.length} conditions, ${haven.traits.length} traits, ${haven.elements.length} elements, ${haven.attributes.length} attributes, ${haven.factions.length} factions, ${haven.mainCats.length} mainCats, ${haven.subCats.length} subCats, ${haven.buildElements.length} buildElements, ${haven.recipes.length} recipes from libVersion ${haven.libVersion} (jar from ${dateStr}).`
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
      mainCats: haven.mainCats.length,
      subCats: haven.subCats.length,
      buildElements: haven.buildElements.length,
      recipes: haven.recipes.length,
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
