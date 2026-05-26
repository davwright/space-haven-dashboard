package dev.spacehaven.dashboard.agent;

import java.lang.instrument.Instrumentation;

/**
 * Space Haven Dashboard streaming agent.
 *
 * <p>Two entry points:
 * <ul>
 *   <li>{@link #premain(String, Instrumentation)} — invoked by the JVM when
 *       launched with {@code -javaagent:agent.jar}. This is the normal path.
 *   <li>{@link #agentmain(String, Instrumentation)} — invoked when the jar is
 *       attached to an already-running JVM via the Attach API. Same behavior.
 * </ul>
 *
 * <p>The agent's responsibilities at this prototype stage are minimal:
 * <ol>
 *   <li>Log to stdout that it's running.
 *   <li>Start the {@link NodeBridge} thread, which maintains a WebSocket
 *       connection to the dashboard's Node server and pumps heartbeat
 *       messages to it.
 * </ol>
 *
 * <p>The {@link Instrumentation} handle is captured for later use (class
 * retransform when we start extracting real game state), but not used yet.
 */
public final class Agent {

  private static volatile Instrumentation instrumentation;
  private static volatile NodeBridge bridge;

  private Agent() {}

  public static void premain(String args, Instrumentation inst) {
    start("premain", inst);
  }

  public static void agentmain(String args, Instrumentation inst) {
    start("agentmain", inst);
  }

  private static synchronized void start(String entryPoint, Instrumentation inst) {
    if (bridge != null) {
      System.out.println("[sh-agent] already started, ignoring " + entryPoint);
      return;
    }
    instrumentation = inst;
    System.out.println("[sh-agent] starting via " + entryPoint
        + " (Java " + System.getProperty("java.version") + ")");

    bridge = new NodeBridge("ws://localhost:7878/agent");
    bridge.startAsync();

    // The aspect publishes ticks through HeartbeatAspect.onTick(); install
    // the consumer that forwards them to the bridge.
    HeartbeatAspect.setSink(NodeBridge::publishTick);

    System.out.println("[sh-agent] running.");
  }

  /** Exposed for the aspect / future hooks. May be null pre-start. */
  public static Instrumentation instrumentation() {
    return instrumentation;
  }

  /** Exposed for tests / shutdown hooks. */
  public static NodeBridge bridge() {
    return bridge;
  }
}
