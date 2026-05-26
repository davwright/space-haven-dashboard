package dev.spacehaven.dashboard.agent;

import java.net.URI;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

/**
 * Maintains a WebSocket connection to the dashboard's Node server and pumps
 * messages to it.
 *
 * <p>Two emission paths today:
 * <ul>
 *   <li>A background thread that fires a "heartbeat" frame every second
 *       regardless of game state, so the Node side can tell the agent is
 *       alive even when the game is paused or a save isn't loaded.
 *   <li>{@link #publishTick(long)} called by {@link HeartbeatAspect}, which
 *       fires every game-loop iteration and lets us see real tick rate end
 *       to end.
 * </ul>
 *
 * <p>Reconnect: if the connection drops or the server is down, we sleep 5s
 * and try again. The wait loop avoids hot-spinning. Connection failures are
 * logged once, not per retry, so we don't spam stdout when the dashboard is
 * offline.
 */
public final class NodeBridge {

  /** Singleton-ish: set by {@link #startAsync()}. */
  private static final AtomicReference<NodeBridge> INSTANCE = new AtomicReference<>();

  private final URI uri;
  private final AtomicReference<WebSocketClient> clientRef = new AtomicReference<>();
  private final AtomicLong heartbeatSeq = new AtomicLong();
  private volatile boolean shutdown = false;
  private volatile boolean lastConnectFailed = false;

  public NodeBridge(String url) {
    this.uri = URI.create(url);
  }

  public void startAsync() {
    INSTANCE.set(this);

    Thread connector = new Thread(this::connectLoop, "sh-agent-ws");
    connector.setDaemon(true);
    connector.start();

    Thread heartbeats = new Thread(this::heartbeatLoop, "sh-agent-heartbeat");
    heartbeats.setDaemon(true);
    heartbeats.start();
  }

  /** Called by the aspect on every weave hit. Cheap — just sends one frame. */
  public static void publishTick(long tick) {
    NodeBridge me = INSTANCE.get();
    if (me == null) return;
    me.sendJson("{\"t\":\"tick\",\"tick\":" + tick + ",\"ts\":" + System.currentTimeMillis() + "}");
  }

  private void connectLoop() {
    while (!shutdown) {
      try {
        WebSocketClient c = new WebSocketClient(uri) {
          @Override public void onOpen(ServerHandshake h) {
            System.out.println("[sh-agent] ws connected to " + uri);
            lastConnectFailed = false;
          }
          @Override public void onMessage(String message) {
            // No inbound commands yet; log so we notice if something arrives.
            System.out.println("[sh-agent] ws <- " + message);
          }
          @Override public void onClose(int code, String reason, boolean remote) {
            System.out.println("[sh-agent] ws closed (" + code + " " + reason + ")");
            clientRef.set(null);
          }
          @Override public void onError(Exception ex) {
            // Only log first error in a streak so we don't flood stdout.
            if (!lastConnectFailed) {
              System.out.println("[sh-agent] ws error: " + ex.getMessage());
              lastConnectFailed = true;
            }
          }
        };
        clientRef.set(c);
        c.connectBlocking();

        // Block here until the socket closes, then retry.
        while (!shutdown && c.isOpen()) {
          Thread.sleep(1000);
        }
      } catch (InterruptedException ie) {
        Thread.currentThread().interrupt();
        return;
      } catch (Exception ex) {
        if (!lastConnectFailed) {
          System.out.println("[sh-agent] ws connect failed: " + ex.getMessage());
          lastConnectFailed = true;
        }
      }
      clientRef.set(null);
      sleepQuietly(5000);
    }
  }

  private void heartbeatLoop() {
    while (!shutdown) {
      long n = heartbeatSeq.incrementAndGet();
      sendJson("{\"t\":\"heartbeat\",\"tick\":" + n + ",\"ts\":" + System.currentTimeMillis() + "}");
      sleepQuietly(1000);
    }
  }

  private void sendJson(String json) {
    WebSocketClient c = clientRef.get();
    if (c == null || !c.isOpen()) return;
    try {
      c.send(json);
    } catch (Exception ignored) {
      // Reconnect loop will pick it up.
    }
  }

  private static void sleepQuietly(long ms) {
    try { Thread.sleep(ms); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
  }

  public void shutdown() {
    shutdown = true;
    WebSocketClient c = clientRef.getAndSet(null);
    if (c != null) c.close();
  }
}
