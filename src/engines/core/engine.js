/**
 * Engine base class.
 *
 * Lifecycle:
 *   engine = await Engine.create({kind, companyId, startedBy})
 *   await engine.transition('authenticating')
 *   await engine.emit('progress', {fetched: 10, total: 100})
 *   await engine.finish({counts: {...}})  // or engine.fail(err)
 *
 * Every transition()/emit() writes one row to engine_runs.state_history AND
 * publishes to the in-memory broker, so any live SSE subscriber receives the
 * event with the same `seq` it'll see on reconnect/replay.
 */

const runsDb = require("./db");
const broker = require("./broker");
const logger = require("../../utils/logger");

class Engine {
  constructor(row) {
    this.id        = row.id;
    this.kind      = row.kind;
    this.companyId = row.company_id;
  }

  static async create({ kind, companyId, startedBy = null }) {
    const row = await runsDb.createRun({ kind, companyId, startedBy });
    const engine = new Engine(row);
    // First event makes the stream non-empty for early subscribers.
    await engine.emit("started", { kind, companyId, startedAt: row.started_at });
    return engine;
  }

  /** Transition to a new state. Optionally include a payload describing the entry. */
  async transition(state, payload = {}) {
    const evt = await runsDb.appendEvent(this.id, { type: "state", state, payload });
    broker.publish(this.id, evt);
    return evt;
  }

  /** Emit a sub-event within the current state (progress, warning, item, etc). */
  async emit(type, payload = {}) {
    const evt = await runsDb.appendEvent(this.id, { type, state: null, payload });
    broker.publish(this.id, evt);
    return evt;
  }

  async finish(result = {}) {
    const evt = await runsDb.appendEvent(this.id, {
      type:    "done",
      state:   "done",
      payload: { result },
    });
    broker.publish(this.id, evt);
    await runsDb.setStatus(this.id, "done", { result });
    // Sentinel so SSE handler can close the connection.
    broker.publish(this.id, { type: "__close__", seq: evt.seq });
  }

  async fail(err, partialResult = null) {
    const message = err?.message || String(err);
    const evt = await runsDb.appendEvent(this.id, {
      type:    "failed",
      state:   "failed",
      payload: { error: message, partialResult },
    });
    broker.publish(this.id, evt);
    await runsDb.setStatus(this.id, "failed", { result: partialResult, error: message });
    broker.publish(this.id, { type: "__close__", seq: evt.seq });
    logger.error("Engine failed", { runId: this.id, kind: this.kind, error: message });
  }

  /** Run a body that may throw; auto-finish/fail based on outcome. */
  async wrap(fn) {
    try {
      const result = await fn(this);
      await this.finish(result || {});
      return { ok: true, result };
    } catch (err) {
      await this.fail(err);
      return { ok: false, error: err?.message || String(err) };
    }
  }
}

module.exports = { Engine };
