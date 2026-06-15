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
 * @returns {Promise<AIMessage>} the model's response message
 */
async function invokeWithFailover(tools, messages, runnableConfig, ctx) {
  const providers = enabledProviders();
  if (providers.length === 0) {
    throw new Error("No LLM providers configured — set OPENAI_API_KEY and/or GROQ_API_KEY");
  }

  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const model = provider.make().bindTools(tools);
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
