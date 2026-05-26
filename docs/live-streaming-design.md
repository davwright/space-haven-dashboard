# Live Streaming Design

This document records the architecture we're committing to for moving the
dashboard from "poll the savefile" to "stream from the running game."
It is not yet implemented; it sets the direction so new code lands in a
style that survives the transition.

## Tempos

Game state changes at three different rates. Treat them differently or
the firehose will dominate.

| Tempo            | Rate                 | Examples                                                                  |
| ---------------- | -------------------- | ------------------------------------------------------------------------- |
| Per-tick         | ~1 Hz, more at speed | crew position, mood, food, rest, gas exposure, conditions, ship coords    |
| Per-event        | seconds–minutes      | crew joined/died, ship encountered, system scanned, derelict found, day rollover, research finished |
| Effectively static| ~once per session    | library data, crew attributes/skills (slow drift), ship structure         |

A naive "push the whole snapshot every tick" design would burn 50–500 KB/s
per client and choke the DOM. We split.

## Data sources

1. **Streaming agent**: a Java agent attached to `spacehaven.jar` via the
   Attach API. It walks live state by reflection (or via the modloader's
   AspectJ injection point set, which already weaves into known classes)
   and emits patches over WebSocket to the Node server.
2. **Savefile fallback**: the current `chokidar` watcher stays. When the
   agent isn't running, the dashboard reads autosaves the way it does
   today. Patches are derived by diffing two adjacent snapshots.
3. **Library import**: unchanged. The jar's `library/haven` and
   `library/texts` are read once per game version into SQLite. Hot
   reloads when the jar's mtime changes.

## Protocol

WebSocket Java → Node, then SSE Node → browser. SSE chosen because the
browser-side stream is one-way; we only need WebSocket on the inner hop
where commands may flow back from Node (e.g. "force a full snapshot now").

Each message is one of:

```jsonc
// Initial full state when a client connects.
{ "t": "snapshot", "tick": 12345, "gameDay": 56, "state": { /* full tree */ } }

// Incremental patch. Multiple ops may share one tick.
{ "t": "patch", "tick": 12346, "ops": [
    { "op": "replace", "path": "/crew/89/mood", "value": -22 },
    { "op": "replace", "path": "/crew/89/food", "value": 18 },
    { "op": "add",     "path": "/crew/89/conditions/-", "value": { "id": 2670, "level": 1 } }
] }

// Per-event marker for the timeline slider, mood log, etc.
{ "t": "event", "tick": 12350, "kind": "ShipEncountered", "payload": { "ship": "HSS WICKED BIRD" } }
```

`ops` follows RFC 6902 JSON Patch. We chose it because:

- Standard, well-specified, libraries exist on both sides.
- Path-addressable: each op names exactly what changed, which lets the
  frontend route updates to the right DOM bindings.
- Mergeable: the agent can coalesce within a tick window so a value that
  flutters -20 → -22 → -25 ships as one op.

Compactness trade-off: JSON Patch is verbose text. We'll start there
because debuggability wins. If transport profiling shows it's the
bottleneck, swap the wire format to msgpack-encoded patches (same
semantics, ~40% smaller). Don't pre-optimize.

### Coalescing

The agent buffers per-tick state and emits at most one patch frame per
200 ms by default (configurable per client). Within that window:

- repeated `replace` on the same path collapses to the last value
- an `add` followed by `replace` on the same path collapses to one `add`
  with the final value
- a path that ends the window with the same value as it began omits

The journal (see Persistence) records every coalesced frame, not raw
ticks.

## Browser-side architecture

This is the part that's choosing-now-or-paying-later. New render code
lands in this style today, even though we're not streaming yet.

### State object

`state.tree` is the canonical client state. Today populated by the SSE
`snapshot` event; later populated by `snapshot` then mutated by `patch`
ops. Render functions NEVER read `state.snapshot` directly anymore;
they accept the data they need as parameters.

### applyOp

```js
function applyOp(op) {
  // 1. Mutate state.tree in place by following op.path.
  // 2. Look up all bindings registered for that path (and its ancestors,
  //    for "this whole subtree changed" handlers).
  // 3. Call each binding's renderFn with the new value.
}
```

Single entry point for all mutation. Initial snapshots are converted to
a stream of `add` ops against an empty tree so the same code path
handles both cold-start and live updates.

### bindCell

```js
function bindCell(path, node, renderFn) {
  // Register a DOM node + render function against a state path.
  // When applyOp fires for that path, the framework calls renderFn(node, newVal, oldVal).
}
```

A cell's render function is responsible for surgical updates:

```js
function renderMoodCell(node, value) {
  node.textContent = Math.round(value);
  node.className = `stat-bar s-${severity('mood', value)}`;
  node.querySelector('.fill').style.width = `${moodPercent(value)}%`;
}
```

Calls to `bindCell` happen during initial render. After that, the
render functions are dormant until their path changes.

### Render layers

| Layer       | When                | What                                                                   |
| ----------- | ------------------- | ---------------------------------------------------------------------- |
| Structural  | Initial load, or large structural change (crew added, tab opened) | Build full DOM subtree via `innerHTML` or `createElement`. Register bindings. |
| Patch       | Per applyOp         | Mutate `textContent`, classes, `style.width` of existing nodes. No re-creation. |
| View switch | User clicks nav tab | Toggle `.view.active` class. Re-register bindings for newly-visible tab if not present. |

### Throttling

Patches arrive at network rate. The browser shouldn't apply 60 ops per
second when the eye can only resolve ~10.

Buffer incoming ops in `pendingOps[]`. On the next `requestAnimationFrame`,
flush all pending ops in a single pass, grouped by target node. This
naturally throttles to 60 fps regardless of network rate, and groups
multiple writes to the same node into one DOM touch.

### Backpressure (slider scrub)

While the user drags the time slider:

- Suspend `applyOp` against `state.tree`. Live ops queue into
  `liveBuffer[]`.
- The slider's view reads from the journal (compacted patches replayed
  forward from the snapshot ≤ slider day).
- When the slider returns to "now" (rightmost), drain `liveBuffer` in
  one `applyOp` pass, then resume real-time.

## Persistence

The current SQLite history (`snapshots`, `body_observations`, etc.) is
kept as the **compacted snapshot per game day**. Every patch frame is
also appended to a journal table:

```sql
CREATE TABLE patch_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER,
  game_day INTEGER,
  emitted_at INTEGER,  -- wall-clock ms
  ops_json TEXT        -- JSON array of ops
);
```

For a given historical day, the dashboard loads:
1. The nearest snapshot ≤ that day
2. All journal rows where `game_day = N` ordered by `id`
3. Replays the ops forward to reconstruct exact state

Truncate the journal beyond ~30 days back to bound storage growth.

## Why not React/Preact/Svelte

Considered and declined for this project specifically:

- The DOM tree is small and tabular (~6 crew × 14 skills = 84 cells).
  Vanilla path-binding outperforms virtual-DOM diffing on workloads
  this size.
- The "no build step" rule has been a real productivity win — edit
  `public/app.js`, hit refresh, see the change. Adding a framework
  brings JSX, bundlers, source maps, hot reload, dep graphs.
- Path-binding is ~80 LOC and we own it. The cost of inventing the
  primitive is roughly equal to the cost of learning a framework's
  reactive model.

We may revisit if the dashboard grows a configuration UI, multi-page
routing, or animations rich enough to benefit from a transition
library.

## Migration plan

We do NOT refactor today. We bias new code so the refactor is small.

| Phase | What                                                                                   |
| ----- | -------------------------------------------------------------------------------------- |
| 0     | Today. Write the framework primitives (`applyOp`, `bindCell`) into a new module but don't wire any renders to them yet. |
| 0.5   | New render code (e.g. food icons, grow-beds) lands in the "function takes only its data, no `state.snapshot` reads inside loops" style. |
| 1     | Java agent prototype connects, emits patches over WebSocket to Node. Node fans out to SSE. Browser logs ops but doesn't apply yet. |
| 2     | Status tab migrates to bind-cell rendering. Verify perf on real stream. |
| 3     | Other tabs migrate. Polling/snapshot fallback kept for offline use. |
| 4     | Journal-replay backs the time slider. |

## Open questions

- **Tick coalescing default**: 200 ms? Per game tick? Configurable per
  client? Pick based on early profiling.
- **Reconnect strategy**: client tracks `lastTick`; on reconnect asks
  server for "everything since `lastTick`" via a one-shot REST call.
  Server keeps a ring buffer of recent ops in memory.
- **What's "state.tree" actually shaped like?** Decision pending; the
  parser's snapshot shape today is close to what we want, with one
  caveat: keys must be stable across patches. Right now `crew` is an
  array indexed by position; should become `crew` as an object keyed
  by `cid` so patches like `/crew/89/mood` work without array reindex
  drama.
- **Java agent injection point**: AspectJ weaver (modloader's path) or
  direct JVM attach + reflection? AspectJ gives stable hook points
  across game updates; reflection breaks every patch. Lean AspectJ.
