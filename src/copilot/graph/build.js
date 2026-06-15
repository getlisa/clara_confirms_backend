/**
 * The copilot agent graph (hand-built StateGraph).
 *
 *   START → agent → (tool_calls? → tools → agent) ... → END
 *
 * Built once as a memoized singleton. Tenant context + permissions are injected
 * per invocation via config.configurable, so one compiled graph safely serves
 * every company. The agent node:
 *   - injects a fresh system prompt (reflects agent_can_make_changes),
 *   - offers only the allowed tool subset (write tools hidden when changes off),
 *   - invokes the model with provider failover.
 *
 * Write tools call interrupt() inside their handler to pause for human
 * confirmation; the PostgresSaver checkpointer persists the paused state so the
 * turn can be resumed later via Command({ resume }).
 */

const { StateGraph, MessagesAnnotation, START, END } = require("@langchain/langgraph");
const { ToolNode } = require("@langchain/langgraph/prebuilt");
const { SystemMessage } = require("@langchain/core/messages");

const { getCheckpointer } = require("./checkpointer");
const { invokeWithFailover } = require("./model");
const prompt = require("./prompt");
const registry = require("../tools/registry");

let _graphPromise;

async function getGraph() {
  if (!_graphPromise) {
    _graphPromise = buildGraph().catch((err) => {
      _graphPromise = undefined; // allow retry on next call
      throw err;
    });
  }
  return _graphPromise;
}

async function buildGraph() {
  const { tools, isWrite } = await registry.build();
  const toolNode = new ToolNode(tools);

  async function agentNode(state, config) {
    const ctx = config?.configurable?.ctx;
    const canMakeChanges = config?.configurable?.canMakeChanges !== false;

    // Hide write tools entirely when the company has changes disabled.
    const allowed = tools.filter((t) => canMakeChanges || !isWrite(t.name));
    const sys = new SystemMessage(prompt.build({ canMakeChanges }));

    const message = await invokeWithFailover(allowed, [sys, ...state.messages], config, ctx);
    return { messages: [message] };
  }

  function shouldContinue(state) {
    const last = state.messages[state.messages.length - 1];
    return last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0 ? "tools" : END;
  }

  const checkpointer = await getCheckpointer();

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, { tools: "tools", [END]: END })
    .addEdge("tools", "agent")
    .compile({ checkpointer });
}

module.exports = { getGraph };
