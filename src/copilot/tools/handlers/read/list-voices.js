const { z } = require("zod");
const retell = require("../../../../services/retell");

const schema = z.object({}).describe("No parameters.");

async function run() {
  const voices = await retell.listVoices();
  const list = (Array.isArray(voices) ? voices : []).map((v) => ({
    voice_id: v.voice_id,
    name: v.voice_name ?? v.name ?? null,
    provider: v.provider ?? null,
    gender: v.gender ?? null,
    accent: v.accent ?? null,
    age: v.age ?? null,
    preview_audio_url: v.preview_audio_url ?? null,
  }));
  return JSON.stringify({ count: list.length, voices: list });
}

module.exports = {
  name: "list_voices",
  description:
    "List the voices available for the AI voice agent (the catalog of selectable voices), each with its voice_id, name, provider, gender and accent. Use this whenever the user asks what voices are available, or wants to browse/pick/change the agent's voice. The voice_id from here is what update_agent_config expects.",
  isWrite: false,
  schema,
  run,
};
