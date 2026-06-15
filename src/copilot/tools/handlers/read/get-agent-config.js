const { z } = require("zod");
const agentSettingsDb = require("../../../../db/agent-settings");

const schema = z.object({}).describe("No parameters.");

async function run(_args, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const settings = await agentSettingsDb.getByCompanyId(companyId);
  return JSON.stringify(settings);
}

module.exports = {
  name: "get_agent_config",
  description:
    "Get the current voice-agent configuration: representative name, selected voice_id, and subagent count. Use to answer 'what voice/name is the agent using?' or before proposing a config change.",
  isWrite: false,
  schema,
  run,
};
