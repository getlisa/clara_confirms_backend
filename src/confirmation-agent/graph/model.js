/**
 * Reuses copilot's provider-agnostic model/failover module as-is
 * (invokeWithFailover is generic over tools/messages/config — nothing
 * copilot-specific in its logic). Same OPENAI_API_KEY/GROQ_API_KEY env vars,
 * same failover order.
 */
module.exports = require("../../copilot/graph/model");
