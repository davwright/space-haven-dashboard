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

**Length-prefixed TCP JSON** Java → Node, then SSE Node → browser. SSE on
the browser hop because the stream is one-way. On the inner hop, TCP is
bidirectional too, so the "commands back from Node" justification doesn't
require WebSocket framing — raw `writeInt(len); writeBytes(json)` is
simpler and lower-latency on localhost ([streaming-research §2](./streaming-research.md)).

Every frame carries a `v` field with the protocol version. Cheap insurance
when the format evolves.

Every frame also carries a `gameVersion` (from haven's `libVersion`
attribute), captured by the agent at startup. The browser refuses to
apply patches whose `gameVersion` doesn't match the current `snapshot`'s
— surfaced as a "game version mismatch, please reload" banner. This is
the safety net for when Bugbyte ships a patch that renames a field and
the agent's pointcuts still match but emit stale paths.

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

**Target latency: ~1 second.** This is a status dashboard, not a
twitch-shooter HUD. The agent buffers per-tick state and emits at most
one patch frame per **1000 ms** by default (configurable per client).
Slower than the 200 ms / 5 Hz the research doc suggests, deliberately:

- The user explicitly accepts 1s end-to-end latency.
- 5 Hz over 1 Hz = 5× the patch frames per second, 5× the journal volume,
  5× the DOM-update work, no perceptual win for non-spatial UI changes.
- Cheaper coalesce window means more aggressive collapse — mood that
  flutters across a second ships as one final value.

If profiling later shows the bottleneck is elsewhere and a faster cadence
is free, the window is one constant to bump.

The coalescer is **two-track**:

- **Path → latest-value map** for `replace` ops. Repeated writes to the
  same path collapse to the last value. An `add` followed by `replace`
  on the same path collapses to one `add` with the final value. A path
  that ends the window with the same value as it began is omitted.
- **Ordered append list** for `event` frames and any `add`/`remove` with
  side effects. Never collapsed, never reordered.

Within one transmitted frame, send the collapsed replaces first, then
the ordered events.

### State key shape

RFC 6902 paths over arrays are positional (`/crew/3/mood` means index 3,
not crew id 89). Reorders desync silently. So entity collections in
`state.tree` are **objects keyed by stable id**, not arrays:

```jsonc
{
  "crew": { "89": {...}, "92": {...} },         // by entId
  "ships": { "35": {...}, "923": {...} },       // by sid
  "bodies": { "255": {...}, "256": {...} },     // by body id
  "storage": { "15": {...}, "17": {...} },      // by elementaryId
}
```

This is a load-bearing decision, not a "later" cleanup. The current
snapshot shape (arrays) must be transformed at the API boundary before
any patch flow exists.

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

At the 1 Hz default cadence, throttling barely matters — patches arrive
slowly enough that direct synchronous `applyOp` calls won't jank.

But the primitive is cheap to build right anyway. Buffer incoming ops
in `pendingOps[]`; on the next `requestAnimationFrame`, flush all
pending ops in one pass, grouped by target node. This:

- handles momentary bursts (e.g. a 500-op snapshot replay during
  slider scrub)
- naturally caps DOM work at 60 fps
- groups multiple writes to the same node into one DOM touch
- keeps live and snapshot paths identical — both go through rAF

### Backpressure (slider scrub)

While the user drags the time slider:

- Suspend `applyOp` against `state.tree`. Live ops queue into
  `liveBuffer[]`.
- The slider's view reads from the journal (compacted patches replayed
  forward from the snapshot ≤ slider day).
- When the slider returns to "now" (rightmost), drain `liveBuffer` in
  one `applyOp` pass, then resume real-time.

## Persistence

The slider's history layer is **separate from the live wire**.

**Do NOT journal the coalesced 200 ms wire patches.** They're a render
convenience: lossy by design, and their resolution is whatever you
happened to flush live — locking the slider's granularity to that
is wrong. ([streaming-research §8](./streaming-research.md))

Three storage layers instead:

- **Per-game-day snapshots** — the existing tables (`snapshots`,
  `body_observations`, `crew_snapshots`, etc.). Domain-aligned interval,
  bounded growth.
- **Event log** — append-only, every `event` frame stored. Never
  coalesced. Drives the slider tick marks and per-day event list.
- **Optional sparser per-N-tick state deltas** — sampled diffs (e.g.
  every 100 ticks) for sub-day scrub granularity. Not required for v1.

```sql
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  game_day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT
);
```

For a given slider day, the dashboard loads:
1. The snapshot for that day
2. The event log entries for that day, in order
3. Renders the snapshot, overlays event markers

Time keys are `tick` (the agent's monotonic counter), NOT wall-clock —
wall-clock drifts across DST and machines, tick is the game's own
clock and is what the user actually means by "when".

### Reconnect ring buffer

Server keeps an in-memory ring of the last **5 minutes** of frames
(~1500 frames at 5/s). On reconnect, the client sends its `lastTick`
and gets either:

- A delta of all frames since `lastTick` if within the ring, OR
- A fresh `snapshot` frame if `lastTick` is older.

Resume request piggybacks on the SSE query string
(`/events?since=12345`) — one transport, no separate REST endpoint.

### Backpressure

When the SSE write returns false (Node's outgoing buffer fills), drop
all `replace` ops EXCEPT the most recent per path, AND drop nothing
from the `event` track. Resume on `drain`. Don't disconnect the client
— this isn't a multi-tenant service. ([streaming-research §6](./streaming-research.md))

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
| 0     | **Done.** Framework primitives (`applyOp`, `applyOps`, `bindCell`, `replaceTree`, `normalizeSnapshot`) shipped in `public/state.js`. Status tab migrated to `bindCell` as proof-of-concept. SSE `snapshot` events now feed `SH.replaceTree`; `patch` events are routed to `SH.applyOps` (stubbed pending agent). |
| 0.5   | New render code (e.g. food icons, grow-beds) lands in the "function takes only its data, no `state.snapshot` reads inside loops" style. |
| 1     | Java agent prototype connects, emits patches over WebSocket to Node. Node fans out to SSE. Browser logs ops but doesn't apply yet. |
| 2     | Status tab migrates to bind-cell rendering. Verify perf on real stream. |
| 3     | Other tabs migrate. Polling/snapshot fallback kept for offline use. |
| 4     | Journal-replay backs the time slider. |

## Operational details

- **Bind to `127.0.0.1` only**, never `0.0.0.0`. The agent stream is
  unauthenticated by design — it's a localhost dev tool. Documenting
  this prevents a future "let's expose this to my LAN" mistake from
  being a CVE.
- **Library hot-reload**: when the jar's mtime changes mid-session, the
  library tables get re-imported, but if a streaming agent is connected
  to the *previous* JVM the IDs may have shifted. Surface a "game restart
  required to refresh" banner; bind library version to JVM process id.
- **Savefile fallback during streaming**: when the agent disconnects mid
  session, chokidar resumes. The browser shows "agent offline → polling
  saves." On agent reconnect, server sends a fresh `snapshot`.
- **Multi-client coordination**: each browser maintains its own
  `state.tree`. There is no shared write state. Commands back to the
  JVM (if any) are scoped to the requesting client.
- **`test` op intentionally unused.** RFC 6902 has it for optimistic
  concurrency; we have one writer and don't need it.

## Open questions

- **Tick coalescing default**: 1000 ms (user accepts 1s latency).
  Research recommends 200 ms but the perceptual win at 5 Hz doesn't
  justify the 5× extra work on a status dashboard.
- **Java agent injection point**: AspectJ weaver via the modloader's
  classpath, riding the modloader's "survive game patches" infrastructure
  rather than building a parallel JVM-attach path. ([streaming-research §3](./streaming-research.md))
- **Sub-day scrub granularity**: do we need sampled mid-day deltas, or
  is per-game-day snapshot + event log enough? Probably enough; defer.
