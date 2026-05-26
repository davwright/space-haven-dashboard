"use strict";

// =============================================================================
//  Java agent <-> Node bridge.
//
//  Hosts a WebSocket server on ws://localhost:7878/agent that accepts a
//  single (or few) connections from the Space Haven JVM agent. Each frame
//  the agent sends gets validated, logged at low volume, and republished as
//  an `agent-heartbeat` SSE event so the browser dashboard can show liveness.
//
//  The Node HTTP server is created in server.js; we attach to it via
//  `noServer: true` + an upgrade handler. This keeps the WebSocket on the
//  same port (4173 by default... wait — the requirement is :7878). For
//  clarity we run the WS server on its OWN port (7878), independent of the
//  dashboard's HTTP port, so the agent's address is stable regardless of
//  what port the user runs the dashboard on.
// =============================================================================

const { WebSocketServer } = require("ws");

const AGENT_PORT = 7878;
const AGENT_PATH = "/agent";
const HEARTBEAT_QUIET_MS = 10_000; // gap after which we log "agent quiet"

function startAgentBridge({ onEvent }) {
  const wss = new WebSocketServer({ port: AGENT_PORT, path: AGENT_PATH });

  let connections = 0;
  let lastFrameAt = 0;
  let quietTimer = null;

  function armQuietTimer() {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (Date.now() - lastFrameAt >= HEARTBEAT_QUIET_MS) {
        console.warn(`[agent-bridge] no frame in ${HEARTBEAT_QUIET_MS}ms`);
      }
    }, HEARTBEAT_QUIET_MS + 500);
  }

  wss.on("connection", (ws, req) => {
    connections += 1;
    console.log(`[agent-bridge] agent connected (${req.socket.remoteAddress}); active=${connections}`);
    // Tell SSE clients we have an agent online.
    onEvent("agent-status", { connected: true });

    ws.on("message", (buf) => {
      lastFrameAt = Date.now();
      armQuietTimer();

      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        console.warn(`[agent-bridge] non-JSON frame: ${buf.toString().slice(0, 80)}`);
        return;
      }

      // Throttle our own console: only log every 10th frame so the terminal
      // isn't flooded at 60 Hz. SSE pass-through is unthrottled.
      if (msg.t === "heartbeat" && msg.tick % 10 === 0) {
        console.log(`[agent-bridge] heartbeat #${msg.tick}`);
      }

      onEvent("agent-heartbeat", msg);
    });

    ws.on("close", () => {
      connections -= 1;
      console.log(`[agent-bridge] agent disconnected; active=${connections}`);
      if (connections === 0) onEvent("agent-status", { connected: false });
    });

    ws.on("error", (err) => {
      console.warn(`[agent-bridge] ws error: ${err.message}`);
    });
  });

  wss.on("listening", () => {
    console.log(`[agent-bridge] listening on ws://localhost:${AGENT_PORT}${AGENT_PATH}`);
  });

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[agent-bridge] port ${AGENT_PORT} in use — another dashboard or agent?`);
    } else {
      console.error(`[agent-bridge] ${err.message}`);
    }
  });

  return { wss };
}

module.exports = { startAgentBridge, AGENT_PORT, AGENT_PATH };
