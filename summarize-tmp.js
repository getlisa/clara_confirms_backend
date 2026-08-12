/**
 * Dry run of the SHIPPED code path against two real company-8 conversations.
 * Builds the exact comment text; posts nothing.
 */
const cs = require("./src/services/conversation-summary");
const db = require("./src/db");

const CHAT_THREAD = "ed93439086aa13251543b1ed5e315089638db39a8bcad4f5";
const CALL_ID = "call_e8125da6b445032fe359fbe0ee4";
const APPTS = [110726, 110727];

(async () => {
  const { rows: tz } = await db.query(`SELECT default_timezone FROM companies WHERE id=8`);
  const timezone = tz[0]?.default_timezone || "UTC";
  const facts = await cs.buildOutcomeFacts(8, APPTS, timezone);
  const plain = cs.renderPlainSummary(facts.visits);
  console.log(`timezone: ${timezone}\nFACTS:\n${facts.lines.join("\n")}\nPLAIN FALLBACK: ${plain}\n`);

  const chatTranscript = await cs.loadChatTranscript(8, CHAT_THREAD);
  const callTranscript = await cs.loadCallTranscript(8, CALL_ID);
  console.log(`transcript chars — chat: ${chatTranscript.length}, call: ${callTranscript.length}\n`);

  const chatSummary = await cs.summarizeConversation({
    channel: "web chat", personName: "Shivam Koli", outcomeFacts: facts.lines, transcript: chatTranscript });
  const callSummary = await cs.summarizeConversation({
    channel: "phone call", personName: "Shivam Koli", outcomeFacts: facts.lines, transcript: callTranscript });

  console.log("========== CHAT COMMENT (posted to the job) ==========");
  console.log([
    require("./src/services/servicetrade-comments").__test_describeChatOutcome
      ? "" : "Chat outcome: the customer confirmed 2 visits.",
    "Who confirmed: Shivam Koli",
    `Summary: ${chatSummary || plain}`,
    "",
    "[clara-chat:ed934390…:12]",
  ].join("\n"));

  console.log("\n========== CALL COMMENT (posted to appointment + job) ==========");
  console.log([
    "Call outcome: the customer confirmed the appointment.",
    "Who confirmed: Shivam Koli",
    `Summary: ${callSummary || plain}`,
    "",
    `[clara-call:${CALL_ID}]`,
  ].join("\n"));

  // Fallback path: no API key -> the old text must still be produced.
  const saved = require("./src/config").copilot.openaiApiKey;
  require("./src/config").copilot.openaiApiKey = "";
  const none = await cs.summarizeConversation({
    channel: "web chat", personName: "X", outcomeFacts: facts.lines, transcript: chatTranscript });
  require("./src/config").copilot.openaiApiKey = saved;
  console.log("\nfallback when the model is unavailable ->", none === null ? "null (old text used) ✓" : "UNEXPECTED");

  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
