/**
 * Express handler for SSE on a single engine run.
 *
 * Protocol:
 *   - Each event is written as `id: <seq>\nevent: <type>\ndata: <json>\n\n`.
 *   - On connect, replay events with seq > Last-Event-ID, then live-tail via broker.
 *   - Heartbeat comment every 15s keeps proxies (Vercel/CF) from killing the socket.
 *   - When the engine finishes/fails, broker publishes a sentinel that closes
 *     the response.
 */

const broker = require("./broker");
const runsDb = require("./db");
const logger = require("../../utils/logger");

const HEARTBEAT_MS = 15_000;

async function streamRun(req, res, { runId, companyId }) {
  const run = await runsDb.getRun(runId, { companyId });
  if (!run) {
    return res.status(404).json({ error: "Engine run not found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy buffering
  res.flushHeaders?.();

  // Initial snapshot — always sent so the client knows the current state machine
  // without waiting for the next event.
  write(res, "snapshot", {
    id:            run.id,
    kind:          run.kind,
    current_state: run.current_state,
    status:        run.status,
    last_event_seq: run.last_event_seq,
    started_at:    run.started_at,
  });

  // Resume from Last-Event-ID (sent by browser EventSource on reconnect, or
  // explicitly by polling clients).
  const sinceSeq = parseInt(req.header("Last-Event-ID") || req.query.last_event_id || "0", 10) || 0;
  const missed = await runsDb.getEventsSince(runId, sinceSeq);
  for (const evt of missed) {
    writeEvent(res, evt);
  }

  // If the run is already terminal, close after replay.
  if (run.status !== "running") {
    res.end();
    return;
  }

  // Live tail.
  const unsubscribe = broker.subscribe(runId, (evt) => {
    if (evt.type === "__close__") {
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    writeEvent(res, evt);
  });

  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }, HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    logger.debug("SSE client closed", { runId });
  });
}

function write(res, type, payload, seq) {
  if (seq != null) res.write(`id: ${seq}\n`);
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeEvent(res, evt) {
  write(res, evt.type, { state: evt.state, ts: evt.ts, ...evt.payload }, evt.seq);
}

module.exports = { streamRun };
