/**
 * LangGraph PostgresSaver checkpointer.
 *
 * Holds per-thread graph state (full message history + paused interrupts) on the
 * same Postgres the app already uses. `setup()` creates the checkpoint tables
 * (idempotent) and is run once, memoized, on first use.
 */

const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");
const config = require("../../config");
const logger = require("../../utils/logger");

let _promise;

async function getCheckpointer() {
  if (!_promise) {
    _promise = (async () => {
      const checkpointer = PostgresSaver.fromConnString(config.database.url);
      await checkpointer.setup();
      logger.info("Copilot checkpointer ready (PostgresSaver)");
      return checkpointer;
    })().catch((err) => {
      _promise = undefined; // allow retry on next call
      throw err;
    });
  }
  return _promise;
}

module.exports = { getCheckpointer };
