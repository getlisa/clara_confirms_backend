/**
 * Reuses copilot's PostgresSaver checkpointer as-is — it's the same
 * physical Postgres DB, and LangGraph's checkpoint tables are shared/
 * generic, namespaced only by thread_id (not per-feature). Copilot's
 * thread ids are `cplt_<uuid>`; this agent's are chat_links tokens (48 hex
 * chars) — no realistic collision, so there's nothing feature-specific to
 * duplicate here.
 */
module.exports = require("../../copilot/graph/checkpointer");
