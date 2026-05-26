# Plan

A living priority list. Top of the file = next up; bottom = done. Items get a
short scope sketch so an agent can pick one up without re-deriving context.

## In progress

_(nothing currently in flight at the moment of writing)_

## Up next — current batch

### Universal item icons in Storage + Nutrition
Extractor currently produces 17 sprites (food-focused). Widen to every
`<Element>` in haven that has an `<objectInfo>` reference into the texture
atlas. Bump `extract-icons.js` so it walks all elements, not just food
heuristics. Expected: ~250+ icons covering construction, raw materials,
gas, every storage item the game has. Frontend already uses `iconImg()` so
the icons appear automatically once on disk.

### Compost + Fertilizer tracking on Nutrition
Surface as their own panel: Compost, Fertilizer, Bio matter, and any
**corpses / bodies** present on the ship (the game lets the composter
consume corpses as input, so they're a real fertility resource the user
wants visible).

Storage counts come for free from `state.snapshot.storage` once we know
the element ids. Backend follow-up: extend the parser to also count corpses
not stored in inventory (entities in the world with type=corpse). Frontend
adds a small "Fertility supply" stat block next to Crops growing.

### Per-recipe ingredient ratios from the save
Found: each kitchen has its facility entry with `<prod pid="N" fpid="89"
…><cinv><f element="X" value="0.0..1.0"/>…</cinv></prod>` recording the
player's slider values. The numbers are weights/proportions the player
chose for that recipe.

Backend: extend `parse-save.js` to scan all `<prod>` blocks under
`fpid="89"` (89 = Kitchen — confirm against haven library) and emit a map
`{ recipe_pid → { element_id → weight, … } }`. Persist into `snapshots`
as `recipe_ratios_json`. Expose via `/history/snapshot/:day`.

Frontend: in recipe cards, when ratio data exists for this recipe pid,
show a small bar under inputs visualising the weights — segmented like
nutrient bars, colored by ingredient.

### Per-bed markers + ETA on Crops growing
Backend already exposes `growBeds[]` with `{ plant_id, growth, stage, bed_x,
bed_y }`. Replace the average-growth bar with one row per crop type
containing a horizontal scale (0–100%) and one dot per bed at its current
growth. Tooltip on the dot: stage name, current growth, ETA to next stage.

ETA derivation: stage time is 1300 ticks (verified in extract-icons run).
Tick rate is ~1 Hz at default game speed; ~1300 seconds ≈ 22 minutes per
stage. Show "~3m to Maturing" / "~14m to Mature" etc.

### Chemistry-style nutrient icons
Replace the plain colored squares in the legend / nutrient labels with
SVG glyphs:
- **Carbs/Sugar** — a hexagon (glucose/fructose silhouette)
- **Protein** — a simplest amino acid backbone (zigzag with NH2 and COOH
  on the ends, abstracted to two small marks)
- **Fat** — a 3-ply zigzag (saturated fatty acid chain)
- **Vitamins** — a multi-ring stylised molecule (something pyridoxine-y)
  or a small starburst
- **Toxins** — skull/biohazard tri-foil (already-ish there; tighten)

Inline SVG in `style.css` via `mask-image` so they recolour with the
existing band CSS. ~40 LOC.

## Backlog — known wants, not started

- **Omniscience audit**: pass over all existing widgets + advisor rules
  to confirm none leak data the player couldn't have learned in-game.
  Document each widget's data dependencies and verify each is gated by
  the appropriate player-observable flag (`isVisible`, `visited`,
  `scanned`, `inspected`, etc.). The invariant is documented in
  `capability-gating-design.md`.
- **Capability gating**: future feature. Widgets and rules declare
  `requires` predicates. Components have three states: **built /
  powered / functioning**. Players have skill levels. Operators must
  be AT the console. Locked widgets show as aspirational greyed-out;
  widgets that LOSE a vital capability (NavConsole destroyed) go to
  **white-noise static** — the ship's computer literally lost its
  sensor feed. See `capability-gating-design.md`.
- **Storage widget internal layout**: categories draggable to reorder,
  collapsible per-category (header click), reflow on container resize
  (CSS Grid auto-fill + ResizeObserver). State persists in widget
  params so the layout survives reload. Pattern reusable by other
  widgets with rich internal layouts. See docking-design.md →
  "Widget-internal behaviors".
- **Notifications widget**: cross-cutting alert feed. Icon + title + body
  (plain text / markdown / HTML / images), severity-banded left rule,
  click body → highlight the referenced data in another widget,
  one-click dismiss, TTL auto-dismiss, stack/collapse by source. If no
  Notifications widget is mounted in the active workspace, fall back
  to corner toasts + a header badge. Spec details in
  `docking-design.md` → "Notifications widget" section. Emission API:
  `SH.notify({icon, title, body, level, highlight, actions, ttl})`.
- Per-crew condition tooltip (icon strip currently just colored dots; on
  hover show condition name + mood/rate effects).
- Map: clickable timeline events for slider scrub (jump to a system on
  click).
- Stuff icons on map (Derelict/WarpGate/Station/HiddenShip already render
  as Unicode glyphs; replace with extracted sprites once the universal
  icon extractor lands).
- Save-folder auto-descent: backend agent flagged that default `saveRoot`
  resolves to `savegames/` but each world is `savegames/<World name>/`.
  Need a one-line auto-descent when `saveRoot` contains no `game` file
  but does contain world subdirs.
- Migrate Skills tab to `SH.bindCell` for live-streaming readiness.
- Migrate Nutrition tab to `SH.bindCell`.
- Migrate Storage tab to `SH.bindCell`.
- Java agent: confirm AspectJ pointcut against real game; first real game
  state extracted over the WebSocket bridge.

## Streaming track — checkpoints

The full architecture is in `live-streaming-design.md`, validated in
`streaming-research.md`. Migration phases:

- ✅ Phase 0 — primitives shipped (`SH.applyOp`, `bindCell`, `replaceTree`,
  Status tab migrated).
- ⏳ Phase 1 — Java agent prototype scaffolded; heartbeat round-trips
  through Node→SSE→browser indicator (commit `7820193`). Real game-state
  extraction is the next step here.
- ⏳ Phase 2 — Skills/Nutrition/Storage/Map migrate to `bindCell` style.
- ⏳ Phase 3 — Length-prefixed TCP between Java and Node (currently
  WebSocket; design doc prefers TCP). Swap in when the agent extracts
  real data.
- ⏳ Phase 4 — Journal replay backs the time slider.

## Recently done

- Show in-game food icons + Crops growing panel on Nutrition (`3c087b7`).
- Fix map body names and stat-bar overflow (`be15dc0`).
- Streaming primitives + Status tab migration (`4f05ded`).
- Version pill in header, auto-bump on `npm start` (`3e1dce6`).
- Streaming research + design doc (`024ba0b`, `99118d4`).
- Java agent prototype scaffolding (`7820193`).
- Storage by category, Kitchen recipes, map body icons + jumpEdges +
  partial-fill skill bars (`cda536a`).
- Backend: storage categories, recipes (82), starjump topology (85),
  per-body stuff field (`42d9a89`).
- Backend: food icons + grow-bed parsing (`c365359`).
- Library import (6829 texts, 202 conditions, 24 traits, 68 elements,
  4 attributes, 11 factions) from `spacehaven.jar`.
- Skill mapping via cross-reference of two crew screenshots.
- Initial dashboard with 3 views (crew, nutrition, galaxy).
