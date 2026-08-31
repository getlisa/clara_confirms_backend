/**
 * invokeWithFailover's tool_choice forcing — the fix for a real gap found
 * reviewing the card-actions-via-agent design: binding a single tool to the
 * model does NOT guarantee it actually calls that tool (a model can just
 * reply with text instead, and shouldContinue routes straight to END with
 * nothing having happened). For propose_remaining_appointments that was a
 * soft miss; for a card-driven confirm/reschedule/cancel it would silently
 * swallow the action. Forcing tool_choice at the API level (both configured
 * providers support the OpenAI-compatible shape) makes the call an API-level
 * guarantee instead of a hope resting on binding + prompt text.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Manual require.cache seeding for two node_modules packages — stub-modules.js's
// own `stub()` helper only resolves paths under src/, so this is done directly
// here rather than through it (same technique, different root).
function stubModule(resolvedPath, exports) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports, children: [], paths: [] };
}

const bindToolsCalls = [];
function fakeChatModel() {
  return {
    bindTools(tools, opts) {
      bindToolsCalls.push({ tools, opts });
      return { invoke: async () => ({ content: "", tool_calls: [], response_metadata: {} }) };
    },
  };
}

stubModule(require.resolve("@langchain/openai"), { ChatOpenAI: function ChatOpenAI() { return fakeChatModel(); } });
stubModule(require.resolve("@langchain/groq"), { ChatGroq: function ChatGroq() { return fakeChatModel(); } });

const { stub } = require("./helpers/stub-modules");
stub("config", { copilot: { openaiApiKey: "test-key", openaiModel: "gpt-4.1", groqApiKey: "", groqModel: "llama" } });
stub("utils/logger", { warn: () => {}, info: () => {}, error: () => {} });

const { invokeWithFailover } = require("../src/copilot/graph/model");

function reset() {
  bindToolsCalls.length = 0;
}

test("with a toolChoice, bindTools is called with tool_choice forcing that exact function and parallel_tool_calls:false", async () => {
  reset();
  await invokeWithFailover([{ name: "confirm_appointment" }], [], {}, {}, "confirm_appointment");
  assert.equal(bindToolsCalls.length, 1);
  assert.deepEqual(bindToolsCalls[0].opts, {
    tool_choice: { type: "function", function: { name: "confirm_appointment" } },
    parallel_tool_calls: false,
  });
});

test("without a toolChoice, bindTools is called with no second argument at all", async () => {
  reset();
  await invokeWithFailover([{ name: "confirm_appointment" }], [], {}, {});
  assert.equal(bindToolsCalls.length, 1);
  assert.equal(bindToolsCalls[0].opts, undefined);
});

test("a null toolChoice behaves identically to omitting it", async () => {
  reset();
  await invokeWithFailover([{ name: "x" }], [], {}, {}, null);
  assert.equal(bindToolsCalls[0].opts, undefined);
});
