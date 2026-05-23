"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { parseSaveFolder } = require("../src/parse-save");

const FIX = path.join(__dirname, "fixtures");

test("parses a save folder: bodies, ships, crew, timeline", () => {
  const r = parseSaveFolder(path.join(FIX, "save-a"));
  assert.ok(r, "parser returns a result");
  assert.equal(r.gameDay, 2, "highest day attr wins");

  // Hidden body excluded by isVisible flag (id=202 is invisible)
  const ids = r.bodies.map((b) => b.body_id).sort();
  assert.deepEqual(ids, ["100", "200", "201"]);

  // Star metadata is captured
  const star = r.bodies.find((b) => b.body_id === "100");
  assert.equal(star.type, "Star");
  assert.equal(star.star_class, "G");
  assert.equal(star.star_type, "MainSequence");
  // Hex-decoded system name
  assert.equal(star.system_name, "Sol");

  // Player ship identification
  assert.equal(r.playerShipId, "500");
  assert.equal(r.playerShipName, "Player Vessel");

  // Non-player ship observed (and the player ship itself is NOT in ships)
  const shipIds = r.ships.map((s) => s.ship_id);
  assert.ok(!shipIds.includes("500"));
  assert.ok(shipIds.includes("501"));

  // Crew: Alice + Bob (Player side); bandit excluded (he's not even in fixture now)
  const crewCids = r.crew.map((c) => c.cid).sort();
  assert.deepEqual(crewCids, ["9001", "9002"]);

  // Flat numeric stats
  const alice = r.crew.find((c) => c.cid === "9001");
  assert.equal(alice.name, "Alice One");
  assert.equal(alice.health, 80);
  assert.equal(alice.mood, 60);
  assert.equal(alice.food, 70);
  assert.equal(alice.ship_name, "Player Vessel");
  assert.equal(alice.nutrition.stomach.protein, 1);
  assert.equal(alice.skills.length, 2);
  assert.equal(alice.jobs[0].profession, "Navigate");
  // Inactive condition slot (id=0 level=0) filtered out
  assert.equal(alice.conditions.length, 1);
  assert.equal(alice.conditions[0].id, 3311);

  // Timeline
  assert.equal(r.timelineEvents.length, 2);
});

test("returns null when no game file exists", () => {
  const r = parseSaveFolder(path.join(FIX, "does-not-exist"));
  assert.equal(r, null);
});
