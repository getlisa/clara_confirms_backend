const { z } = require("zod");
const callSettingsDb = require("../../../../db/call-settings");

const schema = z.object({}).describe("No parameters.");

async function run(_args, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const settings = await callSettingsDb.getByCompanyId(companyId);
  return JSON.stringify(settings);
}

module.exports = {
  name: "get_call_settings",
  description:
    "Get the company's call/agent settings: business hours, max call attempts, voicemail behaviour, alert-days-before, whether the assistant is allowed to make changes (agent_can_make_changes), and the auto-schedule / auto-dispatch toggles.",
  isWrite: false,
  schema,
  run,
};
