# Streaming Architecture Research

## Executive summary

The design in `live-streaming-design.md` mostly holds up — the core choices (JSON Patch as the wire vocabulary, SSE for the browser hop, AspectJ for the JVM hook, 200 ms coalescing, journal-replay for the slider) are all defensible and align with how comparable systems are built in production. The three biggest open risks I'd flag, in order: **(1)** the `state.tree`-with-array-keys problem from Open Questions is bigger than it reads — RFC 6902 paths over arrays are fragile across reorders and the current design will desync silently when crew/ship indices shift; **(2)** there is no plan for **schema versioning** when Bugbyte patches the game and your AspectJ pointcuts go stale or state shapes change — the dashboard will look fine and show wrong numbers; **(3)** the design as written conflates the wire JSON Patch and the journal entries — long-term, the journal should store events/inputs, not coalesced render diffs, or the time-slider will only ever replay the granularity you happened to flush at.

---

## 1. Wire format

**Currently proposed:** RFC 6902 JSON Patch over text on both hops (WS Java→Node, SSE Node→browser). msgpack as a later swap if profiling demands it.

**What I found.** This is a sound starting point and worth keeping. The historical prior art in this exact space is Quake 3's snapshot/delta protocol: server keeps the last 32 snapshots per client and sends a byte-level diff against the most recently acknowledged one, never the full state ([Fabien Sanglard, "Quake 3 Source Code Review: Network Model"](https://fabiensanglard.net/quake3/network.php); [jfedor, "Quake 3 Network Protocol"](https://www.jfedor.org/quake3/)). The conceptual fit with your design is exact — you're doing the same thing with named paths instead of byte offsets, trading compactness for debuggability and structural addressing. Factorio takes the other route: deterministic lockstep, send only inputs, both sides simulate ([Factorio Wiki — Desynchronization](https://wiki.factorio.com/Desynchronization)). That's not available to you (you don't own the simulator). EVE uses adaptive update frequency under load ([0 FPS — Replication in network games: Bandwidth](https://0fps.net/2014/03/09/replication-in-network-games-bandwidth-part-4/)).

On format encoding: msgpack benchmarks at 30–40% smaller and 2–3× faster than JSON with no schema requirement; CBOR is similar in size but consistently slower than msgpack in encoders ([Medium — Protobuf vs MessagePack vs CBOR vs FlatBuffers](https://medium.com/@the_atomic_architect/your-api-isnt-slow-your-payload-is-ca6d0193477c); [arxiv 2201.03051 — Benchmark of JSON-compatible binary serializations](https://arxiv.org/pdf/2201.03051)). FlatBuffers is zero-copy but needs schemas — overkill here.

JSON Merge Patch (RFC 7396) is the other obvious alternative — simpler, no `op` field, just send a partial document ([RFC 7396 — JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396); [erosb — JSON Patch and JSON Merge Patch](https://erosb.github.io/json-patch-vs-merge-patch/)). I considered it and rejected it for you: it can't represent array operations cleanly, can't distinguish "set to null" from "delete", and doesn't compose with the path-binding routing you want on the client.

**Recommendation: keep RFC 6902 + JSON text initially, exactly as designed.** Don't pre-swap to msgpack. But: do explicitly version the protocol (a `v` field in every frame) — this is cheap insurance against future format changes and you'll want it when the second risk below bites.

---

## 2. Transport

**Currently proposed:** WebSocket Java→Node, SSE Node→browser.

**What I found.** SSE for one-way server→client is the right default in 2025/2026 and is consistently the recommended choice for dashboards, feeds, AI token streams ([websocket.org — WebSocket vs SSE](https://websocket.org/comparisons/sse/); [DEV — SSE beat WebSockets for 95% of real-time apps](https://dev.to/polliog/server-sent-events-beat-websockets-for-95-of-real-time-apps-heres-why-a4l)). The one production caveat: SSE can get silently buffered by corporate proxies/CDNs — irrelevant here since this is a localhost dev tool.

For the **inner Java→Node hop on localhost**, WebSocket is over-engineered. Raw TCP with a 4-byte length prefix gets you everything you need (message boundaries, ordered delivery, backpressure via TCP) with zero handshake, zero masking, zero framing complexity beyond `writeInt(len); writeBytes(json)`. A Node.js benchmark shows native IPC at ~18 k ops/s edging out uWebSockets ([dbrugne/node-ipc-vs-ws](https://github.com/dbrugne/node-ipc-vs-ws)). Unix domain sockets are 30–50% lower latency than TCP loopback but Windows-second-class — skip ([nodevibe — Unix Domain Sockets vs TCP loopback](https://nodevibe.substack.com/p/the-nodejs-developers-guide-to-unix)). HTTP/2 streams give you multiplexed flow control but the implementation tax is bigger than the rest of this project.

**Recommendation: change the inner hop to length-prefixed TCP JSON, keep SSE on the browser hop.** The "we might want commands back from Node→Java" justification in the design is real but a TCP socket is bidirectional too — you don't need WebSocket framing for that.

---

## 3. JVM agent technique

**Currently proposed:** Java Attach API to inject the agent; either AspectJ load-time weaving (the modloader path, lean toward this) or reflection.

**What I found.** AspectJ LTW is the correct choice, and confirming the modloader already bundles `aspectj-1.9.19.jar` ([spacehaven-modloader DEVELOPERS.md](https://github.com/Spacehaven-modding-tools/spacehaven-modloader/blob/master/DEVELOPERS.md)) means you ride a path Bugbyte's modders already use — pointcuts (`before` / `after` / `around` on named methods) survive game patches better than reflective field lookups because method names are stable longer than field layouts ([CyanBlob SpaceHavenModTemplate README](https://github.com/CyanBlob/SpaceHavenModTemplate)).

The Minecraft world settled the same question differently: Mixin (SpongePowered, ASM-based) is more flexible than AspectJ but acknowledged as worse for mod compatibility ([Fabric wiki — Introduction to Mixins](https://wiki.fabricmc.net/tutorial:mixin_introduction); [Mixin Basics](https://mixin-wiki.readthedocs.io/mixin-basics/)). For a read-only observability agent, AspectJ's narrower toolkit is a feature.

ByteBuddy is the modern incumbent for general Java agents (JProfiler, Datadog, NewRelic use similar bytecode-rewriting techniques) but you'd be reinventing what's already in the modloader's classpath. Reflection alone — strict no. Field/class names break every patch.

**Recommendation: keep AspectJ LTW. Use the modloader's classpath injection mechanism, don't build a parallel Attach-API path.** Ship the agent as a regular JAR mod that just happens to forward state over a socket — you inherit the modloader's "survive game patches" infrastructure for free.

For the tick-loop hook: don't try to hook the engine tick directly. Pick a method called once per game-day or once per `Sim.update()` and treat that as the rate-limit anchor. If the method is renamed in a patch, the agent silently emits nothing — which is the right failure mode (no false data).

---

## 4. Coalescing / batching

**Currently proposed:** 200 ms window per client, last-writer-wins on same path, `add`+`replace`→`add` with final value, no-op elision.

**What I found.** 200 ms is fine for status-dashboard tempo and roughly matches what professional snapshot games use at the *network* tier (20 Hz = 50 ms is typical for FPS; dashboards run 4–10×slower) ([Daposto — Game Networking: Interval and ticks](https://daposto.medium.com/game-networking-1-interval-and-ticks-b39bb51ccca9); [SnapNet — Snapshot Interpolation](https://snapnet.dev/blog/netcode-architectures-part-3-snapshot-interpolation/)). The eye can't resolve faster than ~10 Hz for non-spatial UI changes.

The coalescing rules you wrote are correct and match what every diff-based reactive system does internally. Missing: **priority/event preservation**. Your `event` frames (`ShipEncountered`, `CrewDied`) MUST never get collapsed even if you ship them in the same window as patches. The design currently treats events as a separate message type, which is right, but be explicit: events are an ordered append-only log, never coalesced.

**Recommendation: keep 200 ms. Make the coalescer two-track:** (a) a path→latest-value map for `replace` ops (collapses), (b) an ordered list for `event` frames and `add`/`remove` ops with side-effects (preserves order). Within one transmitted frame, send the collapsed replaces first, then the ordered events.

---

## 5. Browser-side patch application

**Currently proposed:** `applyOp` mutates `state.tree` in place, looks up bindings registered against the affected path (and ancestors), calls `renderFn(node, newVal, oldVal)`. Throttled via `requestAnimationFrame`.

**What I found.** The pattern has a name: it's **fine-grained reactivity with signals**, the SolidJS model ([Solid docs — Fine-grained reactivity](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity); [Strapi — SolidJS Explained](https://strapi.io/blog/solidjs-explained-fine-grained-reactive-framework); [The New Stack — SolidJS Creator on fine-grained reactivity](https://thenewstack.io/solidjs-creator-on-fine-grained-reactivity-as-next-frontier/)). Your design is a path-keyed variant: instead of subscribing per-signal, you subscribe per-JSON-Pointer. MobX is the same family on a different substrate (observable graphs); your characterisation of "watered-down MobX" is accurate but underselling — it's also "JSON-Pointer-keyed Solid".

For browser application: `fast-json-patch` is the canonical RFC 6902 lib for JS and is designed for hot paths ([Starcounter-Jack/JSON-Patch](https://github.com/Starcounter-Jack/JSON-Patch)). 50–500 ops/sec into a 100 KB tree is well inside its envelope — but only if you skip the validator and use `applyPatch(doc, ops, /*validate*/ false)`. With validation on, it parses every path twice.

The rAF batching idea is correct and matches Phoenix LiveView's morphdom-based approach ([poeticoding — How Phoenix LiveView works](https://www.poeticoding.com/how-phoenix-liveview-works/); [Dashbit — Latency and rendering optimizations](https://dashbit.co/blog/latency-rendering-liveview)). LiveView's diff-tree algorithm sends only the dynamic slots that changed, then morphdom reconciles — semantically the same as your bind-cell model, just with HTML fragments instead of JSON Pointer keys.

**Recommendation: keep the design.** Don't switch to Solid/Mobx — by the time you've added a build step you've spent the framework-learning budget. But: name the thing internally "fine-grained path reactivity" so future-you (and contributors) can find prior art when debugging. Use `fast-json-patch` with validation disabled.

---

## 6. Backpressure & flow control

**Currently proposed:** Not addressed beyond the slider-scrub case.

**What I found.** This is a real gap. The canonical production patterns ([Medium — Node.js + WebSockets Backpressure](https://medium.com/@hadiyolworld007/node-js-websockets-backpressure-flow-control-patterns-for-stable-real-time-apps-27ab522a9e69); [skylinecodes — Backpressure in WebSocket Streams](https://skylinecodes.substack.com/p/backpressure-in-websocket-streams)) for slow clients are: (a) inspect `socket.bufferedAmount` / `getBufferedAmount()`, (b) drop, queue, or disconnect. For a single-user localhost dashboard with one browser, you will essentially never hit this — but you can hit it in a different way: if the agent emits faster than Node fans out (rare here), Node's outgoing SSE write returns false and you must `await drain`.

**Recommendation: cheap addition — when the SSE write returns false, drop everything except `event` frames and the most recent `replace` per path until `drain`.** This is consistent with your coalescing model. Don't disconnect; this isn't a multi-tenant service.

---

## 7. Reconnect & state resync

**Currently proposed:** Open Questions: client tracks `lastTick`; on reconnect REST-fetches "everything since `lastTick`"; server keeps an in-memory ring of recent ops.

**What I found.** Phoenix LiveView uses exponential backoff and either resumes the surviving server process or spins a fresh one and sends a minimal diff against the client's last-known render ([dev.to — Phoenix LiveView's Strategies for Reconnects](https://dev.to/hexshift/staying-alive-phoenix-liveviews-strategies-for-reconnects-recovery-and-real-time-resilience-43l7); [hexdocs — Phoenix LiveView Deployments and recovery](https://hexdocs.pm/phoenix_live_view/deployments.html)). Quake 3 does it server-driven: server tracks per-client last-ack and sends a delta from that snapshot, so if the client missed N frames the next packet just compresses against an older baseline ([fabiensanglard — Quake 3 Network](https://fabiensanglard.net/quake3/network.php)).

Your proposed scheme is correct but the ring-buffer size needs a number: at 5 frames/s × 60 s grace = 300 frames. Cheap. If the client's `lastTick` is older than the ring, fall through to a full snapshot.

**Recommendation: keep, with two specifics.** Size the ring at 5 minutes' worth of frames (cheap). On overrun, send a `snapshot` frame, not an error. Don't bother with a separate REST endpoint — bake the resume request into the SSE query string or the WS upgrade headers; one transport is simpler than two.

---

## 8. Time-travel / journal replay

**Currently proposed:** SQLite `patch_journal` table appending every coalesced patch frame, snapshot per game day, replay forward from nearest snapshot.

**What I found.** This is textbook event sourcing with snapshots ([sqliteforum — Event Sourcing with SQLite: Append-Only Design](https://www.sqliteforum.com/p/event-sourcing-with-sqlite); [Medium — Event sourcing and log compaction](https://medium.com/towardsdev/event-sourcing-and-log-compaction-3959cba0cda4); [Eric Jinks — Undo/redo state with event sourcing](https://ericjinks.com/blog/2025/event-sourcing/)). The standard rule there: snapshot every N events so replay from snapshot is bounded; you've already got "per game day" which is a sensible domain-aligned N.

Redux DevTools' time-travel and Replay.io work the same way — recorded action stream, replay forward from a known state ([blog.isquaredsoftware — Building Better React DevTools with Replay Time Travel](https://blog.isquaredsoftware.com/2023/10/presentations-react-devtools-replay/); [studyraid — Time-travel debugging in Redux](https://app.studyraid.com/en/read/12414/400817/time-travel-debugging-in-redux)).

**The one thing I'd push on hard: the journal should NOT store coalesced render-rate patches.** It should store *events* (`CrewDied`, `ShipEncountered`, day-boundary state diffs) plus periodic snapshots. The coalesced 200 ms patches are a rendering convenience for live clients — recording them means the slider replays at exactly the resolution you happened to be flushing live, with no way to scrub finer. Worse, they're lossy by design (your coalescer collapses path histories), so a "what was mood at tick 12347?" question against the journal cannot be answered. If you only need timeline scrub at game-day granularity that's actually fine — but say so.

**Recommendation: separate live patches from journal entries.** Live wire = coalesced 200 ms frames. Journal = (a) per-game-day snapshots + (b) the `event` stream + (c) optionally a sparser sampled per-N-ticks state-delta. Don't fire-hose the journal with render-rate flutter.

---

## 9. Things we missed

1. **Schema versioning across game patches.** Biggest gap in the doc. When Bugbyte ships a patch that renames `Crew.mood` to `Crew.morale`, your AspectJ pointcut may still resolve (method-level hook) but the field walker emits the wrong path. The dashboard happily applies `replace /crew/89/mood` against a `state.tree` that doesn't have that key. Need: (a) game-version field in the `snapshot` frame, (b) browser refuses to apply patches whose version doesn't match snapshot, (c) the agent emits a `compat` summary on connect listing which pointcuts resolved.

2. **The `crew`-as-array problem is bigger than the doc admits.** RFC 6902 paths over arrays are positional: `/crew/3/mood` means "index 3", not "cid 89". If a crew member dies mid-tick, every subsequent index shifts and every cached binding on the client points at the wrong record. The Open Question says "should become `crew` as an object keyed by `cid`" — that's right, and it's not a "later" change, it has to land before any patch flow exists. Same for ships, conditions, items.

3. **Multi-client coordination.** If two browsers connect, both maintain `state.tree` independently. That's fine on read. But the design hints at commands back from Node→Java ("force a full snapshot now") — define whose request wins, or scope all commands to the requester only. Document explicitly: there is no shared write state.

4. **Security.** The agent is unauthenticated. For a localhost dev tool that's correct — bind only to `127.0.0.1` on both ports, never `0.0.0.0`. State this in the doc; it's the one line that prevents a future "let's expose this to my LAN" mistake from being a CVE.

5. **`test` op never used.** RFC 6902 has a `test` op for optimistic concurrency. You don't need it for one-writer streams, but if you ever do multi-client write-back, it exists. Worth a sentence saying "intentionally unused".

6. **Clock for `emitted_at`.** Wall-clock ms in the journal will drift across timezone changes/DST and across machines. Use monotonic-since-process-start *or* `tick` + wall-clock and let the slider key on `tick`.

7. **Library import hot-reload race.** The doc mentions reloading library data when jar mtime changes. If the user updates Space Haven mid-session, you reload library, but the agent is connected to the *old* JVM — silent skew between library texts and live IDs until the user restarts the game. Bind library-version to JVM-process-id and surface a "game restart required" banner.

8. **No mention of save-file fallback semantics during a streaming-agent session.** If the agent disconnects, does chokidar pick up? Or does the dashboard go stale? Decide.

---

## Sources

- [Fabien Sanglard — Quake 3 Source Code Review: Network Model](https://fabiensanglard.net/quake3/network.php)
- [jfedor — Quake 3 Network Protocol](https://www.jfedor.org/quake3/)
- [0 FPS — Replication in network games: Bandwidth](https://0fps.net/2014/03/09/replication-in-network-games-bandwidth-part-4/)
- [Factorio Wiki — Desynchronization](https://wiki.factorio.com/Desynchronization)
- [RFC 6902 — JSON Patch](https://www.rfc-editor.org/rfc/rfc6902.html)
- [RFC 7396 — JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396)
- [erosb — JSON Patch vs JSON Merge Patch](https://erosb.github.io/json-patch-vs-merge-patch/)
- [Medium — Protobuf vs MessagePack vs CBOR vs FlatBuffers](https://medium.com/@the_atomic_architect/your-api-isnt-slow-your-payload-is-ca6d0193477c)
- [arxiv 2201.03051 — Benchmark of JSON-compatible binary serializations](https://arxiv.org/pdf/2201.03051)
- [websocket.org — WebSocket vs SSE](https://websocket.org/comparisons/sse/)
- [DEV — SSE beat WebSockets for 95% of real-time apps](https://dev.to/polliog/server-sent-events-beat-websockets-for-95-of-real-time-apps-heres-why-a4l)
- [dbrugne/node-ipc-vs-ws benchmark](https://github.com/dbrugne/node-ipc-vs-ws)
- [nodevibe — Unix Domain Sockets vs TCP loopback](https://nodevibe.substack.com/p/the-nodejs-developers-guide-to-unix)
- [spacehaven-modloader DEVELOPERS.md](https://github.com/Spacehaven-modding-tools/spacehaven-modloader/blob/master/DEVELOPERS.md)
- [CyanBlob SpaceHavenModTemplate](https://github.com/CyanBlob/SpaceHavenModTemplate)
- [Fabric wiki — Introduction to Mixins](https://wiki.fabricmc.net/tutorial:mixin_introduction)
- [Eclipse AspectJ — Load-Time Weaving](https://eclipse.dev/aspectj/doc/latest/devguide/ltw.html)
- [Daposto — Game Networking: Interval and ticks](https://daposto.medium.com/game-networking-1-interval-and-ticks-b39bb51ccca9)
- [SnapNet — Snapshot Interpolation](https://snapnet.dev/blog/netcode-architectures-part-3-snapshot-interpolation/)
- [SolidJS — Fine-grained reactivity](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity)
- [The New Stack — SolidJS Creator on fine-grained reactivity](https://thenewstack.io/solidjs-creator-on-fine-grained-reactivity-as-next-frontier/)
- [Starcounter-Jack/JSON-Patch (fast-json-patch)](https://github.com/Starcounter-Jack/JSON-Patch)
- [Dashbit — Latency and rendering optimizations in Phoenix LiveView](https://dashbit.co/blog/latency-rendering-liveview)
- [poeticoding — How Phoenix LiveView works](https://www.poeticoding.com/how-phoenix-liveview-works/)
- [dev.to — Phoenix LiveView reconnect strategies](https://dev.to/hexshift/staying-alive-phoenix-liveviews-strategies-for-reconnects-recovery-and-real-time-resilience-43l7)
- [hexdocs — Phoenix LiveView Deployments and recovery](https://hexdocs.pm/phoenix_live_view/deployments.html)
- [Medium — Node.js + WebSockets Backpressure](https://medium.com/@hadiyolworld007/node-js-websockets-backpressure-flow-control-patterns-for-stable-real-time-apps-27ab522a9e69)
- [skylinecodes — Backpressure in WebSocket Streams](https://skylinecodes.substack.com/p/backpressure-in-websocket-streams)
- [sqliteforum — Event Sourcing with SQLite: Append-Only Design](https://www.sqliteforum.com/p/event-sourcing-with-sqlite)
- [Medium — Event sourcing and log compaction](https://medium.com/towardsdev/event-sourcing-and-log-compaction-3959cba0cda4)
- [Eric Jinks — Undo/redo state with event sourcing](https://ericjinks.com/blog/2025/event-sourcing/)
- [Mark Erikson — Building Better React DevTools with Replay Time Travel](https://blog.isquaredsoftware.com/2023/10/presentations-react-devtools-replay/)
- [Hotwire — Come Alive with Turbo Streams](https://turbo.hotwired.dev/handbook/streams)
