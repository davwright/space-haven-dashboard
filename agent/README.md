# Space Haven Dashboard — Streaming Agent

Java agent that attaches to a running `spacehaven.jar` and pumps live game
state to the dashboard's Node server over WebSocket.

This is the **prototype**. Today it only emits a heartbeat and a tick
counter — enough to prove the JVM-attach + emit-to-Node pipeline works.
Real game-state extraction comes later.

## How it fits

```
spacehaven.jar  --(in-JVM)-->  agent.jar  --(WebSocket)-->  Node server  --(SSE)-->  browser
                  AspectJ                    ws://:7878/agent       /events
                weaves into                  JSON frames            "agent-heartbeat" events
                game classes
```

See `../docs/live-streaming-design.md` for the full architecture.

## Build

Requires Maven and any JDK 8+ on `PATH` (the bundled game JRE is JRE-only,
so it can't build).

```
build.bat
```

Output: `target/agent.jar` (fat jar; WebSocket client is shaded in).

If `mvn` isn't on `PATH`:

1. Install Apache Maven from https://maven.apache.org/download.cgi or use
   `winget install Apache.Maven`.
2. Re-run `build.bat`, or run `mvn -DskipTests package` manually from this
   folder.

The build target is Java 8 because the game's bundled Zulu JRE 8 will refuse
to load classes compiled to newer bytecode.

## Launch the game with the agent attached

```
launch.bat
```

This shells out to the game's bundled JRE with two `-javaagent` flags:

1. `agent.jar` — our agent (Premain-Class hook)
2. `aspectjweaver-1.9.19.jar` — AspectJ's load-time weaver, required to
   activate `HeartbeatAspect`.

The weaver jar is **not** bundled here. The community
[spacehaven-modloader](https://github.com/Spacehaven-modding-tools/spacehaven-modloader)
installs it alongside the game; if you don't run the modloader, drop a
copy at `agent\lib\aspectjweaver-1.9.19.jar` and `launch.bat` will pick it
up.

## Attach to an already-running game

The agent also has an `Agent-Class` so it can be hot-attached with the
JDK's Attach API:

```
jcmd <PID> JVMTI.agent_load <absolute-path-to>\agent.jar
```

(Requires a JDK on the host, not the JRE shipped with the game.)

Hot attach won't enable AspectJ weaving on classes already loaded — the
heartbeat thread still starts and you'll see the per-second frames, but
the per-tick counter only ticks for classes loaded after attach. For full
weaving, launch via `launch.bat`.

## What's in the box

| File | Purpose |
|---|---|
| `Agent.java` | `premain` / `agentmain` entry points. Starts the bridge thread. |
| `NodeBridge.java` | Maintains the WebSocket to Node, reconnects on failure, pumps heartbeat + tick frames. |
| `HeartbeatAspect.java` | `@Before` advice on `SpaceHaven.render(..)`. Increments a counter, logs every 100 ticks. |
| `META-INF/aop.xml` | Tells the AspectJ weaver which aspect to load and which classes to weave. |
| `META-INF/MANIFEST.MF` | `Premain-Class` / `Agent-Class` manifest entries. |
| `pom.xml` | Maven build with shade plugin. |
| `build.bat`, `launch.bat` | Windows convenience wrappers. |

## Message format on the wire

```json
{"t":"heartbeat","tick":42,"ts":1716705600000}
{"t":"tick","tick":12345,"ts":1716705600000}
```

Both are forwarded by the Node server to SSE clients as `agent-heartbeat`
events; the browser uses them to drive the "Agent: connected" indicator.

## Known gaps (prototype)

- No real game state. The aspect counts frames; that's it.
- No reconnect backoff beyond a flat 5s.
- No msg coalescing — every frame triggers a send. Per-frame WebSocket
  sends at 60 Hz are fine for localhost but will need batching before
  this is a real protocol.
- AspectJ weaver isn't auto-located if the modloader isn't installed.
