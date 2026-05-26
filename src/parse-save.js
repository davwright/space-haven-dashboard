"use strict";

// Parses a Space Haven save folder into a structured observation object.
//
// A save folder contains:
//   - `game`            the main XML (galaxy + player ship + crew live here)
//   - `timeline.xml`    a flat list of in-game events with day numbers
//   - `ships/ship<sid>` one XML per ship the player has encountered. These
//                       are the engine's per-ship copies; they do NOT
//                       contain the player crew (those stay in `game`).
//
// Real-file shape we depend on (verified against autosave2):
//
//   <game>
//     <starmap>
//       <systems>
//         <l systemId="1" sn="<hex>" smn="<hex>">
//           <bodies>
//             <l type="Star|Planet|Moon|AsteroidField" id=".." x=".." y=".."
//                starType=".." starClass="..">
//               <info isVisible=".." visited=".." saved=".." deleted=".."/>
//             </l>
//             ...
//           </bodies>
//           <fleets>
//             <f factionId=".." isPlayer="false" x=".." y="..">
//               <createdShips>
//                 <l slid=".." shn=".." crew=".." factionId=".." .../>
//               </createdShips>
//             </f>
//           </fleets>
//         </l>
//       </systems>
//     </starmap>
//     <ships>
//       <ship sid="35" sname="HSS ARA">
//         <characters>
//           <c entId="38" cid="89" side="Player" name="Annika" lname="Bailey">
//             <props>...</props>
//             <pers>...</pers>
//           </c>
//         </characters>
//       </ship>
//     </ships>
//   </game>
//
// Bodies, ships, and crew all live in `game`. The standalone `ships/`
// XMLs add backstory (per-ship layouts) but in this save have no crew.

const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseAttributeValue: true,
  // Force these to arrays so we don't have to branch on "single vs list".
  isArray: (name, jpath) => {
    // Containers that are nearly always a list:
    if (["l", "e", "c", "s", "t", "a", "f", "j", "m"].includes(name)) return true;
    if (name === "ship") return true;
    return false;
  },
});

function readXml(file) {
  if (!fs.existsSync(file)) return null;
  const xml = fs.readFileSync(file, "utf8");
  return parser.parse(xml);
}

// Walk every node in the document, calling visitor(node, parentChain).
// parentChain is the stack of ancestor nodes (newest first).
function walk(node, visitor, chain) {
  if (node === null || typeof node !== "object") return;
  chain = chain || [];
  visitor(node, chain);
  const next = [node, ...chain];
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) val.forEach((v) => walk(v, visitor, next));
    else if (val && typeof val === "object") walk(val, visitor, next);
  }
}

function hexToString(hex) {
  if (typeof hex !== "string") return null;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

function asNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

// ----- Bodies (stars / planets / moons / asteroid fields) -----

const BODY_TYPES = new Set(["Star", "Planet", "Moon", "AsteroidField"]);

function extractBodies(gameDoc) {
  const bodies = [];

  // Find every <systems> container, then read <l systemId=…>{bodies}{<l>…</l>}.
  walk(gameDoc, (node) => {
    if (!node.systems || typeof node.systems !== "object") return;
    const systemArr = Array.isArray(node.systems.l) ? node.systems.l : node.systems.l ? [node.systems.l] : [];
    for (const sys of systemArr) {
      const systemId = sys["@_systemId"] != null ? String(sys["@_systemId"]) : null;
      const systemName = hexToString(sys["@_sn"]) || null;
      const systemShortName = hexToString(sys["@_smn"]) || null;
      const bodyList = sys.bodies && sys.bodies.l ? sys.bodies.l : [];
      const arr = Array.isArray(bodyList) ? bodyList : [bodyList];
      for (const b of arr) {
        const type = b["@_type"];
        if (!BODY_TYPES.has(type)) continue;
        const info = b.info || {};
        // <stuff><s type="Derelict"/><s type="ScannableSector"/><s type="Station" flav="Research"/>…
        // gives the player rich "what's here" cues. We flatten to a list of
        // strings: bare type, or "type:flav" if the <s> has a flav attribute.
        const stuff = extractStuff(b.stuff);
        bodies.push({
          body_id: String(b["@_id"]),
          system_id: systemId,
          system_name: systemName,
          system_short_name: systemShortName,
          type,
          star_type: b["@_starType"] ? String(b["@_starType"]) : null,
          star_class: b["@_starClass"] ? String(b["@_starClass"]) : null,
          celeid: b["@_celeid"] != null ? String(b["@_celeid"]) : null,
          center_id: b["@_centerId"] != null ? String(b["@_centerId"]) : null,
          x: asNum(b["@_x"]),
          y: asNum(b["@_y"]),
          is_visible: asBool(info["@_isVisible"]) ? 1 : 0,
          visited: asBool(info["@_visited"]) ? 1 : 0,
          saved: asBool(info["@_saved"]) ? 1 : 0,
          deleted: asBool(info["@_deleted"]) ? 1 : 0,
          stuff,
          scannable: stuff.some((s) => s.startsWith("ScannableSector")) ? 1 : 0,
        });
      }
    }
  });

  // Only return visible bodies. Hidden ones are not interesting for the
  // fog-of-war timeline (the player can't see them).
  const visible = bodies.filter((b) => b.is_visible && !b.deleted);
  const seen = new Map();
  for (const b of visible) if (!seen.has(b.body_id)) seen.set(b.body_id, b);
  return [...seen.values()];
}

function extractStuff(container) {
  if (!container || typeof container !== "object") return [];
  const arr = Array.isArray(container.s) ? container.s : container.s ? [container.s] : [];
  const out = [];
  for (const s of arr) {
    const t = s["@_type"];
    if (!t) continue;
    const flav = s["@_flav"];
    out.push(flav ? `${t}:${flav}` : String(t));
  }
  return out;
}

// ----- Ships and crew -----

// Pull non-player AI ships out of the galaxy <fleets> sections, and
// simultaneously find the player fleet's galaxy position (x/y/system).
function extractGalaxyShips(gameDoc) {
  const ships = [];
  let playerFleet = null;
  walk(gameDoc, (node) => {
    if (!node.systems || typeof node.systems !== "object") return;
    const systemArr = Array.isArray(node.systems.l) ? node.systems.l : node.systems.l ? [node.systems.l] : [];
    for (const sys of systemArr) {
      const systemId = sys["@_systemId"] != null ? String(sys["@_systemId"]) : null;
      const bodyList = sys.bodies && sys.bodies.l ? sys.bodies.l : [];
      const bodies = Array.isArray(bodyList) ? bodyList : [bodyList];
      for (const body of bodies) {
        const fleets = body.fleets;
        if (!fleets) continue;
        const fArr = Array.isArray(fleets.f) ? fleets.f : fleets.f ? [fleets.f] : [];
        for (const fleet of fArr) {
          const isPlayer = asBool(fleet["@_isPlayer"]);
          if (isPlayer) {
            // Player fleet: capture position once. (There is only one.)
            if (playerFleet == null) {
              playerFleet = {
                x: asNum(fleet["@_x"]),
                y: asNum(fleet["@_y"]),
                system_id: systemId,
              };
            }
            continue; // We track the player ship separately.
          }
          const factionId = fleet["@_factionId"] != null ? String(fleet["@_factionId"]) : null;
          const fx = asNum(fleet["@_x"]);
          const fy = asNum(fleet["@_y"]);
          const cs = fleet.createdShips;
          if (!cs) continue;
          const shipArr = Array.isArray(cs.l) ? cs.l : cs.l ? [cs.l] : [];
          for (const s of shipArr) {
            const slid = s["@_slid"] != null ? String(s["@_slid"]) : null;
            if (!slid) continue;
            ships.push({
              ship_id: slid,
              name: s["@_shn"] ? String(s["@_shn"]) : null,
              faction_id: factionId,
              x: fx,
              y: fy,
              system_id: systemId,
              crew_count: asNum(s["@_crew"]),
              flavor: s["@_flav"] ? String(s["@_flav"]) : null,
              station: asBool(s["@_station"]) ? 1 : 0,
              derelict: asBool(s["@_derelict"]) ? 1 : 0,
            });
          }
        }
      }
    }
  });

  // Dedup by ship_id.
  const seen = new Map();
  for (const s of ships) if (!seen.has(s.ship_id)) seen.set(s.ship_id, s);
  return { ships: [...seen.values()], playerFleet };
}

// Walk the <ships><ship sid> tree in the game file. Each <ship> may contain
// <characters><c .../></characters>. We collect the crew with the enclosing
// ship's metadata so we can identify the player ship.
//
// Some player crew live inside nested carriers (starfighter pods like
// "Contact Light") whose wrapping <c> does NOT have sid/sname. We catch
// those by walking every <characters> block and falling back to the
// nearest ancestor with sid/sname for ship metadata; if there is no such
// ancestor we still keep the crew, just without a ship id.
function extractGameShipsAndCrew(gameDoc) {
  const playerCrew = [];
  const playerShips = new Map(); // sid -> { sid, sname }
  const seenEntIds = new Set();

  walk(gameDoc, (node, chain) => {
    if (!node || typeof node !== "object") return;
    const characters = node.characters;
    if (!characters || typeof characters !== "object") return;
    const cArr = Array.isArray(characters.c) ? characters.c : characters.c ? [characters.c] : [];

    // Walk up the ancestor chain looking for the nearest sid/sname pair —
    // that's the player ship we want to attribute this crew to.
    let shipSid = null;
    let shipName = null;
    if (node["@_sid"] !== undefined && node["@_sname"] !== undefined) {
      shipSid = String(node["@_sid"]);
      shipName = node["@_sname"] ? String(node["@_sname"]) : null;
    } else {
      for (const anc of chain) {
        if (anc["@_sid"] !== undefined && anc["@_sname"] !== undefined) {
          shipSid = String(anc["@_sid"]);
          shipName = anc["@_sname"] ? String(anc["@_sname"]) : null;
          break;
        }
      }
    }

    let hasPlayerCrew = false;
    for (const c of cArr) {
      if (c["@_side"] !== "Player") continue;
      // Crew must have a <pers> block (even if empty) — otherwise it's a
      // vehicle/character template, not an actual person. fast-xml-parser
      // gives us "" for self-closing <pers/>, so check the key, not truthy.
      if (!("pers" in c)) continue;
      const entId = c["@_entId"] != null ? String(c["@_entId"]) : null;
      if (entId && seenEntIds.has(entId)) continue;
      if (entId) seenEntIds.add(entId);
      hasPlayerCrew = true;
      playerCrew.push({ crew: c, shipSid, shipName });
    }
    if (hasPlayerCrew && shipSid) {
      playerShips.set(shipSid, { sid: shipSid, sname: shipName });
    }
  });

  return { playerCrew, playerShips: [...playerShips.values()] };
}

// Convert a raw <c side="Player"> XML node into the flat crew object the
// rest of the app consumes.
function flattenCrew(rawCrew, shipSid, shipName) {
  const c = rawCrew;
  const props = c.props || {};
  const pers = c.pers || {};
  const food = props.Food || {};
  const storedFood = food.stored || {};
  const bellyFood = food.belly || {};

  const flat = {
    cid: c["@_entId"] != null ? String(c["@_entId"]) : (c["@_cid"] != null ? String(c["@_cid"]) : null),
    entity_id: c["@_entId"] != null ? String(c["@_entId"]) : null,
    template_id: c["@_cid"] != null ? String(c["@_cid"]) : null,
    name: [c["@_name"], c["@_lname"]].filter(Boolean).join(" ") || null,
    first_name: c["@_name"] ? String(c["@_name"]) : null,
    last_name: c["@_lname"] ? String(c["@_lname"]) : null,
    side: c["@_side"] ? String(c["@_side"]) : null,
    task: c["@_task"] ? String(c["@_task"]) : null,
    x: asNum(c["@_x"]),
    y: asNum(c["@_y"]),
    ship_id: shipSid || null,
    ship_name: shipName || null,

    // Vital stats
    health: asNum(props.Health?.["@_v"]),
    health_long: asNum(props.Health?.["@_ltv"]),
    food: asNum(food["@_v"]),
    food_long: asNum(food["@_ltv"]),
    rest: asNum(props.Rest?.["@_v"]),
    rest_long: asNum(props.Rest?.["@_ltv"]),
    comfort: asNum(props.Comfort?.["@_v"]),
    comfort_long: asNum(props.Comfort?.["@_ltv"]),
    oxygen: asNum(props.Oxygen?.["@_v"]),
    mood: asNum(props.Mood?.["@_v"]),
    mood_long: asNum(props.Mood?.["@_ltv"]),
    temperature: asNum(props.Temperature?.["@_v"]),
    co2: asNum(props.Co2Gas?.["@_v"]),
    smoke: asNum(props.SmokeGas?.["@_v"]),
    hazardous: asNum(props.HazardousGas?.["@_v"]),

    nutrition: {
      stomach: {
        protein: asNum(storedFood["@_protein"]),
        carbs: asNum(storedFood["@_carbs"]),
        fat: asNum(storedFood["@_fat"]),
        vitamins: asNum(storedFood["@_vitamins"]),
        toxins: asNum(storedFood["@_toxins"]),
      },
      belly: {
        protein: asNum(bellyFood["@_protein"]),
        carbs: asNum(bellyFood["@_carbs"]),
        fat: asNum(bellyFood["@_fat"]),
        vitamins: asNum(bellyFood["@_vitamins"]),
        toxins: asNum(bellyFood["@_toxins"]),
      },
    },

    attributes: extractAttributes(pers),
    skills: extractSkills(pers),
    traits: extractTraits(pers),
    conditions: extractConditions(pers),
    jobs: extractJobs(pers),
    relationships: extractRelationships(pers),
  };

  return flat;
}

function extractAttributes(pers) {
  const arr = pers.attr?.a;
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return list
    .map((a) => ({ id: asNum(a["@_id"]), points: asNum(a["@_points"]) }))
    .filter((a) => a.id != null);
}

function extractSkills(pers) {
  const arr = pers.skills?.s;
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return list
    .map((s) => ({
      sk: asNum(s["@_sk"]),
      level: asNum(s["@_level"]) ?? 0,
      maxLevelNormal: asNum(s["@_mxn"]) ?? 0,
      maxLevelPassion: asNum(s["@_mxp"]) ?? 0,
      exp: asNum(s["@_exp"]) ?? 0,
    }))
    .filter((s) => s.sk != null);
}

function extractTraits(pers) {
  const arr = pers.traits?.t;
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return list.map((t) => asNum(t["@_id"])).filter((id) => id != null);
}

function extractConditions(pers) {
  const arr = pers.conditions?.c;
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return list
    .map((cond) => {
      const id = asNum(cond["@_id"]);
      const level = asNum(cond["@_level"]) ?? 0;
      const moodAcc = collectAccumulators(cond.mood);
      const rateAcc = collectAccumulators(cond.rate);
      return { id, level, moodAccumulators: moodAcc, rateAccumulators: rateAcc };
    })
    // Filter out the inactive zero-slot rows. These exist in the save file
    // as preallocated slots — they have id=0, level=0, and either no mood
    // accumulator at all or a single ac=0 entry.
    .filter((c) => {
      if (c.id == null) return false;
      if (c.id === 0 && c.level === 0) return false;
      return true;
    });
}

function collectAccumulators(container) {
  if (!container) return [];
  const arr = container.m;
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return list.map((m) => asNum(m["@_ac"])).filter((n) => n != null && n !== 0);
}

function extractJobs(pers) {
  const arr = pers.jobsetting?.j;
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return list
    .map((j) => ({
      profession: j["@_profession"] ? String(j["@_profession"]) : null,
      priority: j["@_priority"] ? String(j["@_priority"]) : null,
    }))
    .filter((j) => j.profession);
}

function extractRelationships(pers) {
  const arr = pers.sociality?.relationships?.l;
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return list.map((l) => ({
    target_id: l["@_targetId"] != null ? String(l["@_targetId"]) : null,
    friendship: asNum(l["@_friendship"]),
    attraction: asNum(l["@_attraction"]),
    compatibility: asNum(l["@_compatibility"]),
    last_day_seen: asNum(l["@_lastDaySeen"]),
    lovers: asBool(l["@_lovers"]) ? 1 : 0,
    best_friends: asBool(l["@_bestFriends"]) ? 1 : 0,
  }));
}

// ----- Storage / inventory: best-effort food list per ship -----
// The game's inventory model is complex (containers, processors, conveyors).
// For the dashboard we only need a coarse count per elementaryId, gathered
// from <storage> blocks anywhere in the document.

function extractStorage(gameDoc) {
  // Inventory items live inside <inv><s elementaryId="…" inStorage="…"/></inv>.
  // They appear all over the document: inside ship facilities, processors,
  // containers, etc. We aggregate by elementaryId and treat inStorage as the
  // count contributed by each <s>.
  const totals = new Map();
  walk(gameDoc, (node) => {
    if (!node.inv || typeof node.inv !== "object") return;
    const sArr = Array.isArray(node.inv.s) ? node.inv.s : node.inv.s ? [node.inv.s] : [];
    for (const s of sArr) {
      const elId = s["@_elementaryId"];
      if (elId == null) continue;
      const count = asNum(s["@_inStorage"]) ?? 0;
      if (count <= 0) continue;
      totals.set(String(elId), (totals.get(String(elId)) || 0) + count);
    }
  });
  return [...totals.entries()].map(([elementary_id, count]) => ({ elementary_id, count }));
}

// ----- Grow beds (what crop is growing where) -----
//
// Grow beds in the save look like this:
//
//   <e x=".." y=".." m="921" id="-1" rot="..">      <!-- the bed building -->
//     <l ind="0" ...>
//       <feat cp="..">
//         <grow cpri="0">                            <!-- bed feature -->
//           <inv>...</inv>                          <!-- harvested output -->
//           <cinv>                                  <!-- bed consumables -->
//             <f element="16"   value="0.99"/>      <!-- 16 = Water -->
//             <f element="2475" value="0.8"/>       <!-- 2475 = Fertilizer -->
//           </cinv>
//         </grow>
//       </feat>
//     </l>
//     <l ind="1" ...>
//       <g time="520.9" c="17" st="0" ch="100" se="1" cg="1" ple="1" skup="0"/>
//                  <!-- one plant slot. c=crop element id, st=stage 0..3,
//                       time=time elapsed in current stage, ple=planted? -->
//     </l>
//     ...more <l> slots, some with <g>, some empty
//   </e>
//
// Crops have 4 visible growth stages (haven defines time≈1300 per stage), so
// approximate growth = (st + time/1300) / 4 clamped to [0,1]. We can refine
// later if a stage-time lookup is added, but 1300 is the value for every crop
// we sampled (root veggies / fruits / meat / fibers / nuts / grains).
//
// Stage label is reported alongside the fraction so the UI can distinguish
// "Mature" (st=3 / fraction≈1) from "Growing".
//
// Detection: any <l> whose direct parent <e> contains a descendant <grow>
// block. We don't filter by `m=` so this works for every grow-bed variant
// (mid 184/185/921 today, plus any future ones).

const STAGE_TIME = 1300; // verified for every crop product in haven (2026-05-26)
const STAGE_LABELS = { 0: "Seedling", 1: "Growing", 2: "Maturing", 3: "Mature" };

function extractGrowBeds(gameDoc, parsedShips) {
  const beds = [];
  walk(gameDoc, (node, chain) => {
    if (!node || typeof node !== "object") return;
    // We want each <e> entity that has a <grow> somewhere inside it.
    if (node["@_m"] == null) return; // not an <e> with a build-element id
    // Cheap probe: is there a <feat><grow> anywhere in the subtree?
    let hasGrow = false;
    walk(node, (n) => {
      if (n && typeof n === "object" && n.grow !== undefined) hasGrow = true;
    });
    if (!hasGrow) return;

    const bedX = asNum(node["@_x"]);
    const bedY = asNum(node["@_y"]);
    const bedMid = node["@_m"] != null ? String(node["@_m"]) : null;

    // Nearest ancestor with sid/sname is the ship hosting this bed.
    let shipSid = null;
    for (const anc of chain) {
      if (anc["@_sid"] !== undefined) {
        shipSid = String(anc["@_sid"]);
        break;
      }
    }

    // Each <l> inside the bed may carry a <g> describing one plant slot.
    const lArr = Array.isArray(node.l) ? node.l : node.l ? [node.l] : [];
    for (const l of lArr) {
      if (!l.g) continue;
      const g = l.g;
      const cropId = asNum(g["@_c"]);
      const planted = asBool(g["@_ple"]);
      if (!planted || cropId == null) continue;
      const stage = asNum(g["@_st"]) ?? 0;
      const time = asNum(g["@_time"]) ?? 0;
      // Approximate fractional growth across all four visible stages.
      const stageFrac = Math.min(1, Math.max(0, time / STAGE_TIME));
      const growth = Math.min(1, Math.max(0, (stage + stageFrac) / 4));
      beds.push({
        plant_id: cropId,
        plant_name: null, // resolved at API boundary (we don't have library access here)
        growth,
        stage: STAGE_LABELS[stage] || `Stage ${stage}`,
        stage_index: stage,
        bed_x: asNum(l["@_x"]) ?? bedX,
        bed_y: asNum(l["@_y"]) ?? bedY,
        bed_mid: bedMid,
        ship_id: shipSid,
        tending: asNum(g["@_tends"]) ?? 0,
      });
    }
  });
  return beds;
}

// ----- Star jumps (hyperspace network) -----
//
// The save's <starmap><slines><s s1 sy1 s2 sy2 [w] [bs] [ips] [mp]/> list IS
// the hyperspace jump graph. Each <s> is one edge:
//   sy1 / sy2  system ids (matching <l systemId> elements in <systems>)
//   s1 / s2    body ids INSIDE those systems (typically the AsteroidField
//              that the hyperjump arrives at within each system)
// We expose edges as system→system pairs, deduplicated by unordered system
// pair to drop reverse duplicates the game writes for both directions.
function extractJumpEdges(gameDoc) {
  const edges = [];
  const seen = new Set();
  walk(gameDoc, (node) => {
    if (!node.slines || typeof node.slines !== "object") return;
    const arr = Array.isArray(node.slines.s) ? node.slines.s : node.slines.s ? [node.slines.s] : [];
    for (const s of arr) {
      const sy1 = s["@_sy1"] != null ? String(s["@_sy1"]) : null;
      const sy2 = s["@_sy2"] != null ? String(s["@_sy2"]) : null;
      if (!sy1 || !sy2) continue;
      // Intra-system edges (sy1==sy2) are in-particle-system shortcuts, not
      // interstellar jumps — frontend doesn't draw those, but we still pass
      // them through with intra=1 so the API caller can filter.
      const key = sy1 < sy2 ? `${sy1}|${sy2}` : `${sy2}|${sy1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from_system_id: sy1,
        to_system_id: sy2,
        from_body_id: s["@_s1"] != null ? String(s["@_s1"]) : null,
        to_body_id: s["@_s2"] != null ? String(s["@_s2"]) : null,
        intra: sy1 === sy2 ? 1 : 0,
      });
    }
  });
  return edges;
}

// ----- Standalone ships/ files -----

function extractStandaloneShips(shipsDir) {
  if (!shipsDir || !fs.existsSync(shipsDir)) return [];
  const ships = [];
  for (const name of fs.readdirSync(shipsDir)) {
    const full = path.join(shipsDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const doc = readXml(full);
    if (!doc || !doc.ship) continue;
    const root = doc.ship;
    if (root["@_sid"] == null) continue;
    let hasPlayerCrew = false;
    walk(root, (node) => {
      if (node["@_side"] === "Player" && node["@_cid"] != null) hasPlayerCrew = true;
    });
    ships.push({
      ship_id: String(root["@_sid"]),
      name: root["@_sname"] ? String(root["@_sname"]) : null,
      file: name,
      has_player_crew: hasPlayerCrew,
    });
  }
  return ships;
}

// ----- Timeline -----

function extractTimeline(timelineDoc) {
  const events = [];
  let maxDay = 0;
  walk(timelineDoc, (node) => {
    if (node["@_day"] != null && node["@_type"] != null) {
      const day = asNum(node["@_day"]);
      if (day == null) return;
      if (day > maxDay) maxDay = day;
      let text = null;
      if (node.p != null) text = Array.isArray(node.p) ? node.p.join(" / ") : String(node.p);
      events.push({ day, type: asNum(node["@_type"]), text });
    }
  });
  return { events, currentDay: maxDay };
}

// ----- Top-level driver -----

function parseSaveFolder(folder) {
  const gameFile = path.join(folder, "game");
  if (!fs.existsSync(gameFile)) return null;
  const gameDoc = readXml(gameFile);
  const timelineDoc = readXml(path.join(folder, "timeline.xml"));

  const bodies = extractBodies(gameDoc);
  const { ships: galaxyShips, playerFleet } = extractGalaxyShips(gameDoc);
  const { playerCrew, playerShips } = extractGameShipsAndCrew(gameDoc);

  // Player ship = whichever <ship> in the game file holds player crew.
  // If more than one (extremely rare), prefer the one with the most crew.
  let playerShipId = null;
  let playerShipName = null;
  if (playerShips.length > 0) {
    const counts = new Map();
    for (const c of playerCrew) counts.set(c.shipSid, (counts.get(c.shipSid) || 0) + 1);
    const best = playerShips
      .map((s) => ({ ...s, count: counts.get(s.sid) || 0 }))
      .sort((a, b) => b.count - a.count)[0];
    playerShipId = best.sid;
    playerShipName = best.sname;
  }

  // Cross-check with standalone files. The user's earlier instruction
  // said the player ship "is among" the ships/ folder; in practice the
  // player crew live exclusively in `game` for active games. We still
  // collect the standalone metadata so the UI can list every ship the
  // player has encountered.
  const standaloneShips = extractStandaloneShips(path.join(folder, "ships"));
  for (const sa of standaloneShips) {
    if (sa.has_player_crew && !playerShipId) {
      playerShipId = sa.ship_id;
      playerShipName = sa.name;
    }
  }

  // Filter the player's own ship out of the non-player ship list. Galaxy
  // ships are AI fleets so they will never share an id with the player
  // ship, but a standalone-file ship CAN match (the game writes the
  // player ship as one of the per-ship files in some configurations).
  const ships = galaxyShips.filter((s) => s.ship_id !== playerShipId);

  const crew = playerCrew.map(({ crew, shipSid, shipName }) =>
    flattenCrew(crew, shipSid, shipName)
  );

  const storage = extractStorage(gameDoc);
  const jumpEdges = extractJumpEdges(gameDoc);
  const growBeds = extractGrowBeds(gameDoc);
  const timeline = timelineDoc ? extractTimeline(timelineDoc) : { events: [], currentDay: 0 };

  return {
    savePath: folder,
    gameDay: timeline.currentDay,
    bodies,
    ships,
    standaloneShips,
    crew,
    storage,
    jumpEdges,
    growBeds,
    timelineEvents: timeline.events,
    playerShipId,
    playerShipName,
    playerShipX: playerFleet?.x ?? null,
    playerShipY: playerFleet?.y ?? null,
    playerSystemId: playerFleet?.system_id ?? null,
  };
}

// Side-channel keyed by savePath. Carries data that the existing ingest
// statements don't pass through (stuff_json + scannable per body, and
// jump_edges_json per snapshot). db.js wraps the relevant INSERTs to UPDATE
// these columns immediately after the row is written.
const _extras = new Map();

function _setExtras(savePath, payload) {
  _extras.set(savePath, payload);
}
function _getExtras(savePath) {
  return _extras.get(savePath) || null;
}
function _clearExtras(savePath) {
  _extras.delete(savePath);
}

// Wrap parseSaveFolder to stash the extras for db.js to pick up.
const _originalParseSaveFolder = parseSaveFolder;
function parseSaveFolderWithExtras(folder) {
  const r = _originalParseSaveFolder(folder);
  if (r) {
    const byBody = new Map();
    for (const b of r.bodies) {
      byBody.set(String(b.body_id), {
        stuff_json: b.stuff && b.stuff.length ? JSON.stringify(b.stuff) : null,
        scannable: b.scannable || 0,
      });
    }
    _setExtras(r.savePath, {
      bodies: byBody,
      jump_edges_json: r.jumpEdges && r.jumpEdges.length ? JSON.stringify(r.jumpEdges) : null,
      grow_beds: r.growBeds || [],
    });
  }
  return r;
}

module.exports = {
  parseSaveFolder: parseSaveFolderWithExtras,
  _internals: { walk, readXml, hexToString, flattenCrew, extractBodies, extractJumpEdges, extractStuff, extractGrowBeds },
  _extras: { set: _setExtras, get: _getExtras, clear: _clearExtras },
};
