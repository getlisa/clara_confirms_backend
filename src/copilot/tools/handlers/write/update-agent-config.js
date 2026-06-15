const { z } = require("zod");
const { interrupt } = require("@langchain/langgraph");
const retell = require("../../../../services/retell");
const agentSettingsDb = require("../../../../db/agent-settings");
const { syncFlowForCompany } = require("../../../../services/retell-flow");
const logger = require("../../../../utils/logger");

const schema = z
  .object({
    representative_name: z
      .string()
      .nullish()
      .describe("The name the voice agent uses to introduce itself on calls."),
    voice_id: z
      .string()
      .nullish()
      .describe("The Retell voice id for the agent. Must be a valid voice from the catalog."),
  })
  .refine((v) => v.representative_name != null || v.voice_id != null, {
    message: "Provide at least one of representative_name or voice_id.",
  });

async function run(args, config) {
  const ctx = config?.configurable?.ctx || {};

  // Normalize: the schema allows null (API requirement) — treat null as "not provided".
  const wantsName = args.representative_name != null;
  const wantsVoice = args.voice_id != null;

  // Validate voice_id against the live catalog before proposing.
  if (wantsVoice) {
    let valid = false;
    try {
      valid = await retell.isVoiceIdValid(args.voice_id);
    } catch (err) {
      logger.warn("update_agent_config: voice validation failed", { error: err.message });
    }
    if (!valid) {
      return JSON.stringify({ status: "error", message: `'${args.voice_id}' is not a valid voice id.` });
    }
  }

  const current = await agentSettingsDb.getByCompanyId(ctx.companyId);
  const changes = [];
  if (wantsName && args.representative_name !== current.representative_name) {
    changes.push({ field: "representative_name", from: current.representative_name, to: args.representative_name });
  }
  if (wantsVoice && args.voice_id !== current.voice_id) {
    changes.push({ field: "voice_id", from: current.voice_id, to: args.voice_id });
  }
  if (changes.length === 0) {
    return JSON.stringify({ status: "noop", message: "No changes — values already match." });
  }

  const preview = { entity: "agent_config", changes };

  const decision = interrupt({ type: "confirm_action", tool: "update_agent_config", args, preview });
  if (!decision || decision.decision !== "confirm") {
    return JSON.stringify({ status: "cancelled", message: "The user did not confirm the change." });
  }

  const fields = {};
  for (const c of changes) fields[c.field] = c.to;
  await agentSettingsDb.upsert(ctx.companyId, fields);
  // Rebuild the Retell flow in the background (non-blocking, same as the HTTP route).
  syncFlowForCompany(ctx.companyId).catch((err) =>
    logger.warn("update_agent_config: flow sync failed (non-fatal)", { error: err.message })
  );

  return JSON.stringify({ status: "done", applied: fields });
}

module.exports = {
  name: "update_agent_config",
  description:
    "Update the voice agent's configuration: its representative name and/or its voice. This is a write action: the user will be asked to confirm before it is applied.",
  isWrite: true,
  schema,
  run,
};
