# Capability Gating Design

A future-feature concept: the dashboard is the **ship's computer**.
What it can show is constrained by what the ship has built and what
the crew can operate. As the player progresses — building components,
upskilling crew, completing research — more widgets and rules unlock.

This makes the dashboard part of the game's progression curve rather
than a god-mode overlay.

## Foundational invariant — no omniscience

**The computer cannot know more than the player could know in-game.**
It just has better memory and faster calculation. Everything else
follows from this rule.

Practical consequences:

- **No unscanned data.** If you haven't scanned a system, you don't
  see its bodies. No "X has 4 planets, you just haven't looked." This
  is already how the fog-of-war / `isVisible` filter works; the
  invariant elevates it from feature to law.
- **No unobserved ships' inventories.** You see what a trader has on
  offer only after you've docked and inspected. A future
  `cargo-manifest` widget for another ship requires an "inspected"
  flag in the save (or a recent docking event).
- **No future predictions beyond what the game's UI would tell you.**
  ETAs to harvest stay if the game already shows them in-panel. We
  don't predict crew deaths or invent population trajectories.
- **No revealed enemy stats unless the player would see them.** Combat
  threat assessment can show what the player's scanner would surface:
  hull damage state, crew count, weapon types if known. Hidden stats
  (specific armor values that the player has never seen) stay hidden.
- **No save-file leakage beyond what's on-screen.** The save contains
  more than the game UI shows the player. The dashboard must NOT
  surface those leaks even when the data is technically there.

Memory advantages we DO give the player:

- **Historical recall.** "Where was this ship 12 days ago?" The player
  observed it then; we just remember it for them.
- **Aggregation.** "Average crew mood over the last week." The data
  was all visible; we sum it.
- **Cross-referencing.** "These three crew with Vitamin deficiency
  have Fruits in the storage they passed." The player saw both facts;
  we connect them.
- **Search.** "Find all derelicts I've encountered with hidden ships
  inside." The player knew each one individually; we let them
  re-locate.

When in doubt about whether something is fair: **could the player
have learned this fact by playing the game at some point?** If yes,
remember it. If no, hide it.

### How this shapes implementation

- **Backend respects the invariant before the frontend** — parse-save
  filters to player-observable state. If the save's XML reveals an
  unscanned system's contents, the parser must strip them.
- **`isVisible`, `visited`, `saved`** flags on bodies are already
  gating mechanisms — keep using them.
- **Add `inspected` for ships, `scanned` for asteroid resources, etc.**
  as needed when widgets ask for that data.
- **Advisor rules respect the invariant too.** A rule cannot say
  "asteroid at coords X,Y is iron-rich" unless the player has
  scanned that asteroid in the game.

The capability gating below is mostly about **what features the ship's
computer is good enough to use**. The omniscience invariant is about
**what data the computer has access to in the first place**. Both
apply.

## Examples the user named

- **No galaxy map** until you have a Navigation console built on the
  ship.
- **Computing paths** between systems requires Navigation skill ≥ 5
  on at least one crew member who can operate the console.
- More to come: weapons-readiness widget gated on a Gunnery console +
  a Gunner-trained crew; trade-prices on a Trading terminal; mineral
  scanner output on a Geology bay; etc.

## Core concept

Every widget (and possibly every advisor rule) declares a list of
**capabilities** it requires. The dashboard evaluates which capabilities
the player currently has by reading the save.

### Components have three independent states

A built component is not the same as a working component. The model
captures all three so a widget can require exactly the right level:

| State | Meaning | Predicate |
|---|---|---|
| **built** | The structure exists on the ship | `{ type: "component", id: "NavConsole", state: "built" }` |
| **powered** | Built AND has power flow | `{ type: "component", id: "NavConsole", state: "powered" }` |
| **functioning** | Built + powered + not broken/damaged + atmosphere OK + operator present | `{ type: "component", id: "NavConsole", state: "functioning" }` |

"functioning" is the strict everyday case: the console works right
now. "built" is loosest: you've put it down but it might be damaged,
unpowered, in vacuum, or no one's at it.

A widget that wants to ALWAYS render something useful even when the
console is in disrepair declares `built` and handles the degraded
case itself. A widget that just needs to call into the system in
real-time declares `functioning`.

Components default to `state: "functioning"` if not specified — the
common case.

### Players have skill states

Same shape as the existing crew data:

- **Crew skill** — does ANY player crew member have skill X at level Y
  or higher? `{ type: "skill", skill: "Navigate", level: 5 }`
- **Crew profession assigned** — is anyone working that role?
  `{ type: "profession", role: "Medical", priority: "Normal" }`
- **Crew at console** — is the operator currently AT the component?
  `{ type: "operator-at", component: "NavConsole", skill: "Navigate", level: 5 }`
  (combines presence + skill in one check; the strictest gating)

### Research, resources, etc.

- `{ type: "research", tech: "Hyperdrive" }` — research complete
- `{ type: "resource", id: 71, min: 10 }` — at least N units of element X

### Composing predicates

- `requires: [P1, P2]` — all required (AND)
- `{ any: [P1, P2] }` — n-of (OR within)
- `{ not: P }` — inverse
- `{ all: [P1, P2] }` — explicit AND inside an `any` group

### Example: galaxy map

```js
SH.registerWidget({
  id: "map-galaxy",
  requires: [
    // Need the console built AND powered to see the map at all.
    { type: "component", id: "NavConsole", state: "powered" },
  ],
  features: {
    // Live path calculation needs a skilled crew member AT the
    // working console.
    "path-calculation": [
      { type: "component", id: "NavConsole", state: "functioning" },
      { type: "operator-at", component: "NavConsole", skill: "Navigate", level: 5 },
    ],
    // Showing the system encyclopedia (planet details from prior scans)
    // just needs the console powered.
    "system-encyclopedia": [
      { type: "component", id: "NavConsole", state: "powered" },
    ],
  },
});
```

This means: with the console built but unpowered → widget shows
locked. Powered → widget mounts with the map + scanned info, but the
"calculate path" button is greyed out. Powered + a navigator at the
console with skill 5+ → path calculation unlocks live.

### Three failure states

The dashboard cares about *why* a capability is unmet, not just that
it is. Three distinct cases, three distinct UIs:

| State | Cause | Visual |
|---|---|---|
| **Locked** | Never had it. Console not built; crew never trained that high. | Greyed-out widget body. Tooltip: "Requires X." Friendly, aspirational. |
| **Lost** | Had it before, gracefully degraded. Operator just walked off; power dipped briefly. | Widget body shows last known state with a "stale" overlay. Tooltip: "Operator no longer at console — data from N minutes ago." |
| **Failure / white noise** | Had it, then it broke. Component destroyed, ate a missile, on fire, exploded. | The widget's display **goes to white noise / static**, like a real CRT losing signal. The ship's computer's sensor is GONE; this isn't aspirational, this is a casualty report. |

**The white-noise state is the visceral one.** It's the user's
emergency signal. Galaxy map widget goes to static → the NavConsole
just took a hit. Combat widget goes to static → the WeaponConsole is
slag. Storage widget goes to static → the cargo bay is venting to
space.

#### White-noise rendering

```css
.widget-static {
  position: absolute; inset: 0;
  background:
    repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 2px),
    repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 2px),
    #050608;
  pointer-events: auto;  /* user can still click to dismiss */
  animation: static-flicker 80ms steps(2) infinite;
}
.widget-static::before {
  content: "⚠ SIGNAL LOST";
  position: absolute; inset: 0;
  display: grid; place-items: center;
  color: var(--extreme); font-weight: 700; letter-spacing: 2px;
  text-shadow: 0 0 8px var(--extreme);
}
@keyframes static-flicker {
  0% { background-position: 0 0; }
  50% { background-position: 1px -2px; }
  100% { background-position: -2px 1px; }
}
```

Real white-noise pixel-by-pixel render (the proper effect) costs a
`<canvas>` redrawn at ~30fps. Worth it for the widget that just lost
its console; cheap-but-fine repeating-gradient version above for the
default. Each widget can opt into the canvas version if its loss
matters more.

#### Triggering the static state

The host watches every mounted widget's `requires` continuously
against `SH.capabilities`. When a previously-met `requires` becomes
unmet:

- If the cause is "component went from `functioning` → not-built" or
  "component went from `powered` → unpowered due to damage" or
  "component is now in `destroyed` state" → **white-noise mode**.
- If the cause is "operator walked away" or "transient power dip
  resolved itself" → **lost** mode (stale data).
- If the widget was never satisfied to begin with → **locked**.

The capability engine tags each `building:*` capability with
sub-states the predicate evaluator can read: `destroyed`,
`damaged-but-rebuildable`, `unpowered-by-grid-fault`, etc. The
white-noise vs lost distinction reads these.

#### Audio cue (later)

A short distorted-static sound on transition to white noise would be
appropriately dramatic. Defer — silent by default.

### Lock vs disabled vs static — summary

If a widget's `requires` is unmet for the first time, the WIDGET is
**locked** (cool grey, aspirational). If a previously-mounted widget
loses a non-critical capability, it goes to **lost / stale** (last
known, faded). If it loses a **vital** capability (component
destroyed), it goes to **white noise** — the ship's computer just
lost its sensor.

If a `features.X` predicate is unmet, only that FEATURE inside the
widget is greyed; same three sub-states apply at the feature level.

## Widget contract addition

```js
SH.registerWidget({
  id: "map-galaxy",
  name: "Galaxy Map",
  category: "Navigation",
  // ...
  requires: [
    { type: "building", id: "NavConsole" },
    // OR: any of several alternatives
    { any: [{ type: "skill", skill: "Navigate", level: 5 },
            { type: "research", tech: "ManualNavigation" }] },
  ],
  // OR more granular: features within a widget can be locked separately:
  features: {
    "path-calculation": [{ type: "skill", skill: "Navigate", level: 5 }],
    "system-encyclopedia": [{ type: "research", tech: "Hyperdrive" }],
  },
});
```

`requires` is a list ANDed together. Each entry can be:

- `{ type: "building", id: "NavConsole" }` — ship has at least one
  building with that internal Space Haven id
- `{ type: "skill", skill: "Navigate", level: 5 }` — any player crew
  has skill ≥ level (uses our existing skill mapping)
- `{ type: "profession", role: "Medical" }` — any crew assigned
- `{ type: "research", tech: "Hyperdrive" }` — research complete
- `{ any: [...] }` — OR within (n-of)
- `{ not: { ... } }` — inverse

The default is `requires: []` (no gating). Widgets without `requires`
are always available. Existing widgets can stay ungated; this is opt-in.

## Capability engine

A small module that:

1. Reads `SH.tree` for the current ship state.
2. Builds a `capabilities` set, recomputed when the tree changes:
   - For each building on the player ship, emit `building:<id>`
   - For each player crew, emit `skill:<name>:<level>` (cumulative —
     skill 5 implies skill 4, 3, …)
   - For each profession set to Normal or higher priority on any
     crew, emit `profession:<name>`
   - For each completed research, emit `tech:<id>` (when research data
     is in the extractor — currently not)
3. Exposes `SH.capabilities` as the canonical reachable set.
4. Exposes `SH.evaluateRequires(predicate)` that any caller (widget,
   rule) can use to check unlock state.

Persists nothing — it's a derived view of game state.

## How widgets respond

The docking host, when mounting a widget, evaluates its `requires`. If
it fails, instead of `def.render(container, ctx)` it calls:

```js
function renderLocked(container, def, missing) {
  container.innerHTML = `
    <div class="widget-locked">
      <div class="locked-icon">🔒</div>
      <div class="locked-title">${def.name} is locked</div>
      <div class="locked-body">Requires: ${missing.map(humanize).join(", ")}.</div>
    </div>
  `;
}
```

When the capability set later changes (e.g. you finish building the
NavConsole), the host detects bound widgets that were locked + are
now satisfied, and `dispose+mount` them properly.

## Palette filtering

The widget palette (when built) shows ALL widgets, but greys out
locked ones and shows their requires as a tooltip. Drag from palette
is allowed even for locked widgets — they mount in locked state. This
way the user can pre-plan a layout: "I'll have the Captain's bridge
ready for when I unlock Navigation."

## Advisor rules

Same pattern. Each `SH.registerRule` may include `requires`. The engine
skips evaluation for unmet rules — no insights emitted. The
`mining-opportunity` rule, for example, could require Mining skill ≥ 2
(you can't really mine without that anyway).

This automatically suppresses irrelevant noise in the early game.

## Building IDs

Space Haven's haven library defines buildings as Elements with
`<objectInfo>`. The component requires a small lookup of internal
building ids by name (e.g. `NavConsole`, `WeaponConsole`, `MedicalBay`,
`Composter`, `GrowBed`). When we extend the extractor we'll build
this table alongside `element_defs`. Until then, the building check
falls through and emits zero `building:*` capabilities — gated
widgets stay locked.

## Implementation phases

1. **Capability engine** (no widget gating yet). Pure module that
   computes `SH.capabilities` from `SH.tree`. Just data, no UI impact.
2. **Building extractor extension**. Parse the player ship to identify
   built components by their building-id. Until this lands, building
   capabilities are unknown.
3. **Widget contract extension**. Add `requires` to the registration
   contract; have the host render locked state when not met.
4. **First gated widget**: `map-galaxy`. Test the unlock path: dashboard
   shows locked widget; player builds NavConsole; dashboard's tree
   updates; widget mounts properly.
5. **Per-feature gating** (the `features:` block in the contract). E.g.
   inside the galaxy widget, the path-finding overlay is only drawn
   when the Navigate ≥ 5 capability is present. Other features of the
   map work without it.
6. **Advisor rule gating**. Same `requires` block, same evaluator.

## Why this is good

- **Aligns the tool with the game's progression.** The dashboard isn't
  a cheat; it's a representation of "what your ship's computer is
  capable of telling you."
- **Reduces overwhelm for new players.** Early game shows a small set
  of widgets; locked ones tease what comes next without cluttering.
- **Provides goals.** "I want the galaxy map widget unlocked → I need
  to build the NavConsole."
- **Re-uses data we already have.** Player crew skills are already
  tracked; building presence is one extractor extension away. No new
  game-state plumbing needed in steady state.

## Open questions

- **Does the player want a "god mode" toggle to bypass gating?** For
  out-of-game analysis ("what if my crew were better?") this is
  useful. Recommend: a setting in the dashboard, off by default.
- **What about WIDGETS THAT CONFIGURE THE SHIP?** This dashboard is
  read-only today. Future "I want to assign Annika to operate the
  NavConsole" actions would need a write-back. Defer; the gating
  design doesn't depend on it.
- **Do per-feature locks confuse users?** ("The galaxy map widget is
  loaded but won't compute paths"). Probably yes if not visualised
  well. Mitigate: locked sub-features render their own locked
  placeholder inside the widget. Like a grey overlay over the
  "calculate route" button.
- **Multiple workspaces, mixed capability state:** if a workspace has
  many locked widgets, do we show them locked or hide them? Recommend:
  show them locked. Visible locks teach the player what to aim for.
