# Advisor Layer Design

The dashboard so far surfaces *raw game state*. The advisor layer is a
separate concern: **derived insights the game itself never tells you**.

**Constraint:** The advisor must respect the omniscience invariant
documented in `capability-gating-design.md` → "No omniscience." Rules
can only reason about data the player could have learned in-game.
They cannot invent unseen facts. If the user hasn't scanned a system,
no rule reasons about its contents.
Examples the user has named:

- 🛰  Asteroids are passing through your current system but your
  starfighter's launch policy is "Stay docked" — you're missing free
  resources.
- 🤝  A trader ship just arrived in the sector — based on its inventory
  and your current cargo + storage gaps, here's what you could sell to
  it for a good price.
- 🔀  Two trader ships are in the same sector. Ship A is selling X at
  price P; ship B will buy X at price P+30. You could shuttle between
  them and arbitrage.
- 🌱  Your grow-bed mix is heavy on Root vegetables but your crew's
  belly is deficient in protein — plant Nuts or switch to Algae.
- 💊  Annika has a Vitamin deficiency anemia condition AND there are
  Fruits in storage — drafting her to eat would clear it faster than
  waiting for her schedule.

None of these are in the savefile. The savefile is the *substrate* the
advisor reasons about.

## Layer separation

```
┌─────────────────────────────────────────────────────────────┐
│ Widgets (UI)                                                │
│ — render data, call SH.notify(...) when surfacing advice    │
├─────────────────────────────────────────────────────────────┤
│ Advisor rules                                               │
│ — pure functions: (state.tree) → [Insight, ...]             │
│ — each rule is a small module: "name, watch paths, evaluate"│
│ — the rules ENGINE re-runs the rule when its watched paths  │
│   change                                                    │
├─────────────────────────────────────────────────────────────┤
│ State tree (SH.tree, populated by snapshots / patches)      │
└─────────────────────────────────────────────────────────────┘
```

Rules are pure: same state → same insights. They don't render, they
don't mutate. They emit `Insight` objects that the host turns into
notifications, list items in dedicated widgets, badges, etc.

## Rule contract

```js
SH.registerRule({
  id: "mining-opportunity",                  // stable, used in insight dedup
  name: "Mining opportunity",                // user-readable
  category: "Resources",
  description: "Asteroids near your starfighter while it's docked",

  // Paths in SH.tree this rule depends on. The engine re-runs the rule
  // only when one of these subtrees changes. Same model as bindCell
  // for widgets, but rules return data instead of touching the DOM.
  watch: [
    "/bodies",
    "/ships",
    "/playerSystemId",
  ],

  evaluate(state) {
    // Pure: return an array of Insight objects (possibly empty).
    const sys = state.playerSystemId;
    const nearbyAsteroids = Object.values(state.bodies)
      .filter(b => b.system_id === sys && b.type === "AsteroidField" && b.stuff?.includes("Resource"));
    const starfighter = Object.values(state.ships).find(s => s.is_player_starfighter);
    if (!starfighter) return [];
    if (starfighter.launch_policy !== "StayDocked") return [];
    if (nearbyAsteroids.length === 0) return [];
    return [{
      id: `mining-opportunity-${sys}`,         // dedup key
      severity: "warning",
      icon: "🛰",
      title: `${nearbyAsteroids.length} asteroid${nearbyAsteroids.length>1?"s":""} in current system`,
      body: `Your starfighter "${starfighter.name}" has launch policy "Stay docked". Free resources are passing by.`,
      actions: [
        { label: "Show on map",        focus: { widget: "map-system", target: sys } },
        { label: "Open starfighter",   focus: { widget: "ship-config", target: starfighter.id } },
      ],
      // Optional structured data the rule wants to expose to dedicated widgets
      data: { systemId: sys, asteroidIds: nearbyAsteroids.map(a => a.body_id), shipId: starfighter.id },
    }];
  },
});
```

Notes:

- Rule IDs are stable. If the same insight `id` is emitted across
  evaluations, the engine **replaces** the previous one rather than
  stacking duplicates — important when a rule fires every tick.
- The engine evaluates lazily: a rule only runs when at least one watched
  path has changed since its last evaluation.
- Rules are sync. If a rule needs async data (e.g. fetching trade prices
  from a separate endpoint), it pre-fetches via a side-channel into
  `SH.tree` and watches the result; the rule stays pure.

## Insight shape

```js
{
  id:        "stable-key",     // dedup across re-evaluations
  ruleId:    "mining-opportunity", // back-reference
  severity:  "info" | "warning" | "critical" | "success",
  icon:      "🛰" | "/icons/N.png",
  title:     "short",
  body:      "longer prose, supports md/html (see notifications spec)",
  actions:   [ { label, focus: { widget, target } } | { label, do: fn } ],
  data:      { /* structured payload for dedicated advisor widgets */ },
  emittedAt: tickOrTimestamp,  // host fills in
}
```

## Surfacing insights

Three rendering pathways, each driven by the same `Insight` stream:

1. **Notifications widget** (already specced) — every insight becomes a
   card. User dismisses or acts. If no notifications widget is mounted,
   the host shows a corner toast + header badge.

2. **Advisor list widget** — a dedicated panel for "what should I do
   right now?" Shows every active insight grouped by severity. Always
   visible while active; auto-removes when the rule stops emitting it.

3. **Per-category advisor widgets** — narrow views for specific
   advisor families. E.g. a `trade-advisor` widget shows only insights
   with `category: "Trade"`. A `crew-advisor` shows only `Crew`. Same
   underlying insight stream, filtered.

The notifications + advisor-list widgets are the catch-all; category
widgets are optional power-user views.

## Rule library (initial set)

The first rules to ship, in priority order:

### Resources
- `mining-opportunity` — asteroids in current system while starfighter
  docked (the motivating example).
- `salvage-opportunity` — derelict in current system, no salvage crew
  assigned.
- `unmined-frontier` — scanned system has minable resources you haven't
  visited.

### Trade
- `trader-arrived` — non-faction-hostile ship just appeared in current
  system; here's what you could trade.
- `arbitrage` — two ships in current system where their inventories +
  trade prices favour shuttling between them. Most interesting rule;
  needs trade-price data first.
- `cargo-overflow` — storage is filling up; sell or jettison.

### Crew
- `condition-fixable` — a crew condition (e.g. Vitamin deficiency anemia)
  has an obvious in-storage remedy.
- `idle-skilled` — high-skill crew with no current task they can use the
  skill on.
- `injury-untreated` — crew has Injured / Burn wound and no medic is
  assigned or available.

### Botany / Food
- `nutrient-gap` — average crew belly is deficient in macro X while
  current crops produce mostly macro Y.
- `crop-mature` — beds at >90% growth waiting to be harvested.

### Navigation
- `route-faster-via` — current planned jump has a shorter alternative
  through a scanned system.
- `system-unexplored` — within hyperdrive range, has minable resources,
  and you haven't been there.

### Combat

Threats in Space Haven come in three distinct shapes — the model needs
to score each one differently:

- **Hostile ships** — armed external vessels in the same system.
  Strength = weapons damage × armor × shield capacity × crew
  count × combat skill. Includes pirates, patrols, hostile factions.
- **Alien monsters** — bug-creatures, hive infestations on derelicts /
  inside your ship. Strength = monster type × count × your weapon /
  armor / shooting-skill loadout per crew. Different stat shape: no
  shields, but high melee damage.
- **Human boarders** — pirates, military strike teams entering your
  ship. Strength = boarder count × their weapons × armor × melee skill,
  scored room-by-room as they advance. Worst case scenario because
  they're already past your hull defences.

Rules to ship:

- `threat-assessment` — for each detected threat in current system,
  score combat strength against ours and bucket the outcome
  (decisive win / favourable / even / unfavourable / lose badly).
  Surfaces the dominant deltas ("they have 2× shields", "their melee
  is +40%"). Supports all three threat types via separate scoring
  models, same insight shape.
- `boarding-readiness` — your defender complement vs incoming
  boarders or vs the bug count on a derelict you're about to enter:
  fighter skill, armor tier, weapon loadout. Says "send 4 crew, not
  2" or "don't board, you'll lose."
- `infestation-spread` — alien hive on your ship; track room
  contamination and project how many doors before it reaches your
  bridge / oxygen / power.
- `engagement-window` — for ship vs ship, if their shields are down or
  recharging slower than your weapons, flag "good time to attack."
- `flee-feasibility` — for ship vs ship, can you outrun them?
  Hyperdrive ready time vs. their interceptor speed. For boarders /
  monsters, "where can the crew fall back to?"

Most of these require backend extension first: weapons/armor/shield
specs per ship, monster types and stats from haven, current crew
weapon loadouts, room-adjacency for spread modeling. Many fields are
in the save under the ship XML; some need cross-referencing into
haven. Document each rule's data dependencies as it's built.

Most rules are one watched path + one filter + ~20 LOC. The arbitrage
rule will be the most complex (needs trade-price modelling).

## Engine implementation sketch

```js
// In SH (state.js or new advisor.js)

const rules = new Map();         // id → Rule
const insights = new Map();      // insight.id → Insight (currently active)
const subscribers = new Set();   // notifications widget, advisor-list, …

function registerRule(rule) { rules.set(rule.id, { ...rule, lastFingerprint: null }); }

function evaluateAll() {
  const next = new Map();
  for (const rule of rules.values()) {
    const fp = fingerprintPaths(SH.tree, rule.watch);
    // Skip if nothing in watched paths changed.
    if (fp === rule.lastFingerprint) {
      // Reuse prior insights for this rule.
      for (const i of insights.values())
        if (i.ruleId === rule.id) next.set(i.id, i);
      continue;
    }
    rule.lastFingerprint = fp;
    const out = rule.evaluate(SH.tree) || [];
    for (const i of out) {
      next.set(i.id, { ...i, ruleId: rule.id, emittedAt: SH.tick });
    }
  }
  // Diff old vs new.
  const added = [...next.values()].filter(i => !insights.has(i.id));
  const removed = [...insights.keys()].filter(k => !next.has(k));
  insights.clear();
  for (const [k, v] of next) insights.set(k, v);
  for (const sub of subscribers) sub({ added, removed, all: [...insights.values()] });
}
```

Trigger `evaluateAll()` after every `applyOps` flush — same place
bindings fire.

Performance: with ~10 rules each watching ~3 paths, this is a few
hundred operations per tick. Negligible at 1 Hz.

## Hidden facts the advisor needs

Some rules want data the savefile doesn't directly expose:

- **Trade prices** — haven library has `TradingValues`. The modloader
  annotates it. We haven't imported it yet; needed for any trade rule.
- **Faction stance** — friendly / neutral / hostile derived from
  faction id; needs joining against haven's Faction defs (already
  partly there).
- **Hyperdrive range** — your ship's max jump distance. In save under
  the ship's spec.
- **Ship launch policy / patrol rules** — need to find in save.
- **Crew profession + work efficiency** — already in save, just need
  to surface.

Each rule should document its data dependencies. When a dependency
isn't available yet, the rule registers but stays silent until the
backend extends to provide it. No crashes from missing fields.

## What goes where

- **Pure rules** → `public/advisor/rules/*.js`, each rule a tiny module.
  Imported and registered at boot.
- **Engine** → `public/advisor/engine.js` exposes `SH.registerRule`,
  `SH.insights`, evaluation hook.
- **Detection rules requiring backend data** → first the backend
  extension (e.g. extract `TradingValues`), then the rule.
- **Widgets that surface insights** → standard widget contract; the
  notifications widget subscribes via `SH.onInsights(...)`.

## Phasing

1. **Engine + first rule** — `SH.registerRule`, evaluateAll plumbing,
   ship `mining-opportunity` as the smoke test. Render via toast since
   notifications widget isn't built yet.
2. **Notifications widget** — already specced in `docking-design.md`;
   builds the rendering pathway for insights.
3. **Advisor-list widget** — catch-all panel for active insights.
4. **Backend data for trade rules** — extract `TradingValues` from haven,
   add ship-inventory tracking from save.
5. **Trade + arbitrage rules** — the headline feature once data is there.
6. **The rest of the rule library** — opportunistic; add as the user
   identifies missing alerts.

## Open questions

- **Suppression**: user dismisses a notification; should the rule
  *stop* emitting that insight ID for a while, or re-emit it on every
  evaluation? Recommend: dismiss adds the insight ID to an in-memory
  mute list with a configurable cooldown (default: until the rule's
  watched paths next change). Stops noisy re-emit; doesn't lose the
  alert permanently.
- **User-authored rules**: down the line, let users write rules in a
  small DSL or even raw JS without restarting the dashboard. Defer.
- **Rule priorities / ranking**: when many rules fire at once, what
  shows first? Recommend: by severity, then by ruleId. No per-rule
  weight initially.
- **Test harness**: rules are pure, so they're trivially testable.
  Each rule ships with a `test/<rule-id>.test.js` that feeds it a
  synthetic state.tree and asserts on insights.
