"use strict";

// Space Haven internal ID -> human name lookups.
//
// Conditions, traits, items, attributes and factions are resolved from the
// library tables imported out of spacehaven.jar (see scripts/import-library.js
// and the auto-import on server startup). When the library hasn't been
// imported yet (e.g. the user doesn't have the jar on disk), every lookup
// falls back to "Condition #1582" / "Item #16" / "#210" placeholders so the
// UI keeps working.
//
// Skills are NOT in the library — haven defines them implicitly via the
// engine rather than as numbered entities. We have not found a reliable
// mapping from save <s sk="N"> values to text ids, so skills still fall
// back to "Skill #N" placeholders.

const db = require("./db");

// Canonical Space Haven professions, copied straight from the <j profession>
// strings the engine writes. These ARE reliable.
const PROFESSIONS = [
  "Navigate",
  "Gunner",
  "Shield",
  "Operations",
  "Fighter",
  "Medical",
  "Farm",
  "Botany",
  "Construct",
  "Maintenance",
  "Mine",
  "Industry",
  "Research",
  "Logistics",
  "Cook",
];

// Lazy-prepared statements so we don't crash when lookups.js is required
// before the library tables exist. import-library.js creates the tables on
// first run; we re-prepare on demand and tolerate "no such table" errors.
let _stmts = null;
function stmts() {
  if (_stmts) return _stmts;
  try {
    _stmts = {
      condById: db.prepare(
        "SELECT cd.id, cd.color, cd.meta, t.en AS name FROM condition_defs cd LEFT JOIN text_defs t ON t.tid = cd.name_tid WHERE cd.id = ?"
      ),
      traitById: db.prepare(
        "SELECT td.id, t.en AS name FROM trait_defs td LEFT JOIN text_defs t ON t.tid = td.name_tid WHERE td.id = ?"
      ),
      elementById: db.prepare(
        "SELECT e.id, e.type, e.sort_group, e.sort_pos, t.en AS name FROM element_defs e LEFT JOIN text_defs t ON t.tid = e.name_tid WHERE e.id = ?"
      ),
      attrById: db.prepare(
        "SELECT a.id, t.en AS name FROM attribute_defs a LEFT JOIN text_defs t ON t.tid = a.name_tid WHERE a.id = ?"
      ),
      factionById: db.prepare(
        "SELECT f.id, f.side, t.en AS name FROM faction_defs f LEFT JOIN text_defs t ON t.tid = f.name_tid WHERE f.id = ?"
      ),
      techById: db.prepare(
        "SELECT td.id, td.category, td.cost, t.en AS name FROM tech_defs td LEFT JOIN text_defs t ON t.tid = td.name_tid WHERE td.id = ?"
      ),
    };
    return _stmts;
  } catch {
    // Tables don't exist yet (no library imported).
    return null;
  }
}

// The in-game storage filter labels its tabs by these names. They are NOT in
// haven.xml as data — Bugbyte hard-codes the labels per <sort s=N> bucket.
// Verified by sampling representative members of each group against day-56
// save 2026-05-26: s=1 Energium/Hyperium/Building tools; s=2 Root veggies /
// Fruits / Artificial meat; s=3 Rubble / Hull Block / Energy block; s=4
// Fibers / Grains / Chemicals; s=5 Base metals / Ice / Noble metals; s=6
// Smoke / Power / Heat.
const SORT_GROUP_NAMES = {
  1: "Resources",       // refined metals, tools, energy crystals
  2: "Food",
  3: "Construction",    // rubble / hull / energy blocks
  4: "Fabric",          // fibers, grains, chemicals
  5: "Raw Materials",   // base metals, ice, ore
  6: "Gas / Energy",    // smoke, power, heat
};

function sortGroupName(s) {
  if (s == null) return null;
  return SORT_GROUP_NAMES[s] || `Group #${s}`;
}

function safeGet(stmtName, id) {
  const s = stmts();
  if (!s) return null;
  try {
    return s[stmtName].get(id);
  } catch {
    return null;
  }
}

function conditionInfo(id) {
  const r = safeGet("condById", id);
  if (!r || !r.name) return { id, name: `Condition #${id}`, color: null };
  return { id, name: r.name, color: r.color, meta: r.meta };
}

function traitInfo(id) {
  const r = safeGet("traitById", id);
  if (!r || !r.name) return { id, name: `Trait #${id}` };
  return { id, name: r.name };
}

function elementInfo(id) {
  const r = safeGet("elementById", id);
  if (!r || !r.name) return { id, name: `Item #${id}`, sort_group: null, sort_pos: null, category: null };
  return {
    id,
    name: r.name,
    type: r.type,
    sort_group: r.sort_group,
    sort_pos: r.sort_pos,
    category: sortGroupName(r.sort_group),
  };
}

function attributeInfo(id) {
  const r = safeGet("attrById", id);
  if (!r || !r.name) return { id, name: `Attribute #${id}` };
  return { id, name: r.name };
}

function factionInfo(id) {
  const r = safeGet("factionById", id);
  if (!r || !r.name) return { id, name: `Faction #${id}` };
  return { id, name: r.name, side: r.side };
}

function techInfo(id) {
  const r = safeGet("techById", id);
  if (!r || !r.name) return { id, name: `Tech #${id}` };
  return { id, name: r.name, category: r.category };
}

// Skill `sk=N` values in saves don't have a numbered definition in haven; the
// mapping was reverse-engineered by cross-referencing two crew members' save
// data against their in-game Skills panels (Annika Bailey + Andrew Heacock on
// 2026-05-24). sk=12 and sk=13 are the two skills not visible in the standard
// 12-skill panel — they're almost certainly Maintenance and Logistics, but
// which is which is unverified.
const SKILL_NAMES = {
  2:  "Mining",
  3:  "Botany",
  4:  "Construct",
  5:  "Industry",
  6:  "Medical",
  7:  "Gunner",
  8:  "Shielding",
  9:  "Operations",
  10: "Weapons",
  12: "Maintenance",  // unverified — could be Logistics
  13: "Logistics",    // unverified — could be Maintenance
  14: "Navigation",
  16: "Research",
  22: "Piloting",
};

function skillInfo(sk) {
  const name = SKILL_NAMES[sk];
  return { id: sk, name: name || `Skill #${sk}` };
}

// Fertility-supply element ids. Discovered by SELECT id FROM element_defs
// JOIN text_defs against haven libVersion 1.0.1_steam_2 (2026-05-26):
//   - Bio Matter = 71  (compost input)
//   - Fertilizer = 2475 (compost output)
// There is no separate "Compost" item — Compost is the *process* the
// composter runs (Bio Matter + corpses → Fertilizer + Water). The Fertility
// panel surfaces all three storage counts plus the live corpse count.
const FERTILITY_ELEMENT_IDS = {
  bioMatter: 71,
  fertilizer: 2475,
  // Kept for API symmetry with the UI's "Compost:" label — no element id,
  // composter outputs Fertilizer (the eid above). Frontend can show the same
  // count under both names if it wants, or omit.
  compost: null,
};

// Compact string accessors for legacy callers.
const conditionName = (id) => conditionInfo(id).name;
const attributeName = (id) => attributeInfo(id).name;
const skillName = (id) => skillInfo(id).name;
const traitName = (id) => traitInfo(id).name;
const elementName = (id) => elementInfo(id).name;
const factionName = (id) => factionInfo(id).name;

// Apply names to a crew object in-place. The frontend reads `.name` on each
// nested condition / trait / skill / attribute and falls back to numeric ids.
function decorateCrew(crew) {
  if (!crew || typeof crew !== "object") return crew;
  if (Array.isArray(crew.conditions)) {
    for (const c of crew.conditions) {
      const info = conditionInfo(c.id);
      c.name = info.name;
      c.color = info.color;
    }
  }
  if (Array.isArray(crew.traits)) {
    // traits is a list of ids (numbers). Re-shape into { id, name } objects
    // for the frontend.
    crew.traits = crew.traits.map((id) => {
      if (typeof id === "object") return id;
      return traitInfo(id);
    });
  }
  if (Array.isArray(crew.attributes)) {
    for (const a of crew.attributes) {
      a.name = attributeInfo(a.id).name;
    }
  }
  if (Array.isArray(crew.skills)) {
    for (const s of crew.skills) {
      s.name = skillInfo(s.sk).name;
    }
  }
  return crew;
}

function decorateStorage(items) {
  if (!Array.isArray(items)) return items;
  return items.map((s) => {
    const info = elementInfo(Number(s.elementary_id));
    // `main_cat_name` mirrors the in-game storage filter tab label (Food /
    // Construction / etc.), derived from <product><sort s=N>. Products are
    // not linked to <MainCat>/<SubCat> in haven (those are build-menu only),
    // so we expose the storage-group label here as the closest equivalent.
    // sub_cat_name stays null because the storage UI in-game has no second
    // level — there's no data to fill it from.
    return {
      ...s,
      name: info.name,
      type: info.type,
      sort_group: info.sort_group,
      sort_pos: info.sort_pos,
      main_cat_name: info.category,
      sub_cat_name: null,
    };
  });
}

module.exports = {
  PROFESSIONS,
  conditionInfo,
  traitInfo,
  elementInfo,
  attributeInfo,
  factionInfo,
  skillInfo,
  techInfo,
  conditionName,
  attributeName,
  skillName,
  traitName,
  elementName,
  factionName,
  decorateCrew,
  decorateStorage,
  sortGroupName,
  SORT_GROUP_NAMES,
  FERTILITY_ELEMENT_IDS,
};
