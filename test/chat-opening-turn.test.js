/**
 * The graph must actually WITHHOLD the opening-turn tools.
 *
 * registry.getToolsForPhase takes an isOpeningTurn flag, and
 * precall-context.chat-prompt.test.js pins its behaviour — but calling the
 * registry directly proves nothing about whether the agent node passes the
 * flag. Deleting `{ isOpeningTurn }` from the call site broke no test until
 * this file existed, which is exactly the regression that reintroduces the
 * duplicate greeting.
 *
 * So this drives the REAL compiled graph with a stubbed model and an in-memory
 * checkpointer, and records the tools the model was actually offered.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { AIMessage, HumanMessage } = require("@langchain/core/messages");
const { MemorySaver } = require("@langchain/langgraph");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });
stub("db/llm-call-logs", { logCall: async () => {} });
stub("db/service-line-descriptions", { listByCompany: async () => [] });

// A fixed job context, so the phase is always "confirming".
stub("services/job-confirmation-context", {
  buildJobConfirmationContext: async () => ({
    ok: true,
    tz: "America/Chicago",
    job: { id: 1, job_number: "J1", title: "Job", description: null, comments: [], customer: { name: "Acme" }, location_name: "Site A" },
    appointments: {
      upcoming: [{
        appointment_id: 11, scheduled_start_spoken: "Thursday", service_line: "Sprinkler",
        service_summary: "Sprinkler", customer_confirmed: false, status: "scheduled",
        arrival_window_spoken: "between 8 AM and 9 AM", technicians: [], technician_names: [],
      }],
      history: [],
    },
    counts: { upcoming: 1, unconfirmed: 1, all_confirmed: false },
  }),
});

// A real saver, so the graph's own "has the agent spoken yet" state is genuine.
stub("confirmation-agent/graph/checkpointer", { getCheckpointer: async () => new MemorySaver() });

// Record what each agent invocation was offered.
const offered = [];
stub("copilot/graph/model", {
  invokeWithFailover: async (tools) => {
    offered.push(tools.map((t) => t.name).sort());
    return new AIMessage({ content: "ok" });   // no tool calls → one pass per turn
  },
  enabledProviders: () => [{ id: "test" }],
});

const { getGraph } = require("../src/confirmation-agent/graph/build");

const CONFIG = (thread) => ({ configurable: { thread_id: thread, ctx: { companyId: 8, jobId: 1, threadId: thread } } });

test("the opening turn is offered neither report_customer_intent nor end_conversation", async () => {
  offered.length = 0;
  const graph = await getGraph();
  await graph.invoke({ messages: [new HumanMessage("(opening trigger)")] }, CONFIG("t-open"));

  assert.equal(offered.length, 1, "one agent pass for a turn with no tool calls");
  assert.ok(!offered[0].includes("report_customer_intent"),
    "a tool call in the opening message routes back through the agent, which then greets a second time");
  assert.ok(!offered[0].includes("end_conversation"));
  assert.ok(offered[0].includes("confirm_appointment"), "the phase's real actions must still be offered");
});

test("the next turn gets them back", async () => {
  offered.length = 0;
  const graph = await getGraph();
  const cfg = CONFIG("t-second");
  await graph.invoke({ messages: [new HumanMessage("(opening trigger)")] }, cfg);
  await graph.invoke({ messages: [new HumanMessage("yes please")] }, cfg);

  assert.equal(offered.length, 2);
  assert.ok(!offered[0].includes("report_customer_intent"), "opening: withheld");
  assert.ok(offered[1].includes("report_customer_intent"), "second turn: the customer has now spoken");
  assert.ok(offered[1].includes("end_conversation"));
});
