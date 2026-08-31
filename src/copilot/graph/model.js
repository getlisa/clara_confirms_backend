/**
 * Provider-agnostic chat model with failover.
 *
 * Providers are tried in order (OpenAI → Groq). If one fails to respond
 * (network/timeout/5xx/rate-limit), we fall through to the next. Adding a
 * provider = add one descriptor to PROVIDERS. LangSmith traces each attempt as a
 * span when tracing env vars are set.
 *
 * We bind tools to each provider's model individually (so the model can call
 * our tools) and pass the RunnableConfig through to .invoke() so the call is
 * traced under the active graph run and token streaming is captured by
 * graph.streamEvents().
 */

const { ChatOpenAI } = require("@langchain/openai");
const { ChatGroq } = require("@langchain/groq");
const config = require("../../config");
const logger = require("../../utils/logger");

const PROVIDERS = [
  {
    id: "openai",
    enabled: () => !!config.copilot.openaiApiKey,
    make: () =>
      new ChatOpenAI({
        model: config.copilot.openaiModel,
        apiKey: config.copilot.openaiApiKey,
        temperature: 0,
        streaming: true,
      }),
  },
  {
    id: "groq",
    enabled: () => !!config.copilot.groqApiKey,
    make: () =>
      new ChatGroq({
        model: config.copilot.groqModel,
        apiKey: config.copilot.groqApiKey,
        temperature: 0,
        streaming: true,
      }),
  },
];

function enabledProviders() {
  return PROVIDERS.filter((p) => p.enabled());
}

/**
 * Invoke the LLM with the given tools and messages, failing over across
 * providers. Emits a `provider` event on success (or `provider_switch` when a
 * non-primary provider answers) via ctx.emit so the UI can show which model
 * responded.
 *
 * @param {string|null} [toolChoice] — when given, forces the model to call
 *   exactly this tool (an API-level guarantee on both configured providers,
 *   OpenAI-compatible `tool_choice` shape) rather than relying on binding a
 *   single tool + prompt instructions and hoping the model actually calls it
 *   — a model bound to one tool can still just reply with text instead,
 *   which for an appointment action would silently swallow it. Additive/
 *   optional: existing callers that never pass it are unaffected.
 * @returns {Promise<AIMessage>} the model's response message
 */
async function invokeWithFailover(tools, messages, runnableConfig, ctx, toolChoice = null) {
  const providers = enabledProviders();
  if (providers.length === 0) {
    throw new Error("No LLM providers configured — set OPENAI_API_KEY and/or GROQ_API_KEY");
  }

  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const model = toolChoice
        ? provider.make().bindTools(tools, {
            tool_choice: { type: "function", function: { name: toolChoice } },
            parallel_tool_calls: false,
          })
        : provider.make().bindTools(tools);
      const message = await model.invoke(messages, runnableConfig);
      if (ctx?.emit) {
        if (i === 0) await ctx.emit("provider", { provider: provider.id });
        else await ctx.emit("provider_switch", { from: providers[0].id, to: provider.id });
      }
      return message;
    } catch (err) {
      lastErr = err;
      logger.warn("Copilot LLM provider failed", { provider: provider.id, error: err.message });
      if (i === providers.length - 1) throw err;
      // Otherwise loop to the next provider; the success branch above emits the switch.
    }
  }
  throw lastErr;
}

module.exports = { invokeWithFailover, enabledProviders };
