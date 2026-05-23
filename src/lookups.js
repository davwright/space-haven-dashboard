"use strict";

// Space Haven internal ID lookup tables.
//
// These IDs were found in real save files. Where the value is null/unknown,
// the UI falls back to "Condition #1582" style placeholders. Contributors
// are very welcome to send PRs filling these in — see the IDs collected
// below from the user's autosave2:
//
//   conditions: 1053, 1582, 2246, 2668, 2669, 2670, 3311, 3312, 3325, 3361
//   attribute IDs (<a id=…>): 210, 212, 213, 214 (likely Bravery / Health /
//       Stamina / Intelligence in some order)
//   skill IDs (<s sk=…>): 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 16, 22
//   trait IDs (<t id=…>): 1535
//
// Skill / profession mapping uses the <j profession="…"> strings the game
// emits directly. Those names ARE authoritative — the IDs in <skills> are
// the ones we can't yet map without verified screenshots.

const CONDITION_NAMES = {
  // Filled in only when the user has explicitly confirmed the mapping.
  // Until then, the UI shows "Condition #ID".
};

const ATTRIBUTE_NAMES = {
  // 210, 212, 213, 214 → unknown order of Bravery/Health/Stamina/Intelligence.
};

const SKILL_NAMES = {
  // Same caveat as attributes — IDs known, mapping not verified.
};

const TRAIT_NAMES = {
  // 1535 → unknown.
};

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

function conditionName(id) {
  return CONDITION_NAMES[id] ?? `Condition #${id}`;
}
function attributeName(id) {
  return ATTRIBUTE_NAMES[id] ?? `Attribute #${id}`;
}
function skillName(id) {
  return SKILL_NAMES[id] ?? `Skill #${id}`;
}
function traitName(id) {
  return TRAIT_NAMES[id] ?? `Trait #${id}`;
}

module.exports = {
  CONDITION_NAMES,
  ATTRIBUTE_NAMES,
  SKILL_NAMES,
  TRAIT_NAMES,
  PROFESSIONS,
  conditionName,
  attributeName,
  skillName,
  traitName,
};
