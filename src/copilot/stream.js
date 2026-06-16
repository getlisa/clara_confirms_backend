/**
 * Map LangGraph streamEvents → engine/broker events (the SSE wire protocol).
 *
 * Channels the frontend can render distinctly:
 *   - token            live text deltas, tagged with message_id + channel
 *   - message          a completed assistant generation, classified as
 *                      channel:"reasoning" (the generation also made tool calls —
 *                      i.e. intermediate thinking) or channel:"answer" (final reply)
 *   - tool_call        the agent invoking a tool (paired by tool_call_id)
 *   - tool_result      that tool's response/data (paired by tool_call_id)
 *
 * Token deltas are HIGH volume, so they go straight to the in-memory broker
 * (live-only, not persisted) to keep engine_runs.state_history small. The
 * low-volume milestones (message, tool_call, tool_result) go through
 * engine.emit so they ARE persisted and replay on reconnect — so even if the
 * ephemeral tokens are missed, the classified `message` text is recoverable.
 */

const broker = require("../engines/core/broker");

/**
 * Normalize the `on_chat_model_end` output into a single AIMessage, across the
 * shapes LangChain may hand back (a message, or an LLMResult with generations).
 */
function endMessage(output) {
  if (!output) return null;
  if (output.tool_calls !== undefined || typeof output.content !== "undefined") return output;
  const gen = output.generations?.[0]?.[0];
  return gen?.message || null;
}

function hasToolCalls(msg) {
  return Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
}

function extractText(chunk) {
  if (!chunk) return "";
  const content = chunk.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  return "";
}

const MAX_TOOL_TEXT = 12000;

function summarizeOutput(output) {
  // Tool output is typically a JSON string (ToolMessage content). Tools return
  // structured JSON that the frontend renders as cards/tables, so we parse and
  // pass it through WITHOUT truncation. Only raw (non-JSON) strings are capped.
  let text;
  if (output == null) return null;
  else if (typeof output === "string") text = output;
  else if (output.content != null) text = String(output.content);
  else return output; // already a structured object

  try {
    return JSON.parse(text);
  } catch {
    return text.length > MAX_TOOL_TEXT ? text.slice(0, MAX_TOOL_TEXT) + "…" : text;
  }
}

/**
 * Consume a graph streamEvents iterator, emitting channel-tagged events.
 *
 * Live tokens are tagged with `message_id` (the model run id) so the client can
 * group them into a bubble. The channel ("reasoning" vs "answer") is only known
 * once the generation finishes, so it is sent on the `message` event keyed by
 * the same message_id — the client renders tokens live, then styles that bubble
 * when the matching `message` arrives.
 */
async function pump(engine, events) {
  const runId = String(engine.id);
  for await (const ev of events) {
    switch (ev.event) {
      case "on_chat_model_stream": {
        const text = extractText(ev.data?.chunk);
        if (text) broker.publish(runId, { type: "token", payload: { text, message_id: ev.run_id } });
        break;
      }
      case "on_chat_model_end": {
        const msg = endMessage(ev.data?.output);
        const text = extractText(msg);
        // A generation that also makes tool calls is intermediate "thinking";
        // one with no tool calls is the final answer. Skip empty (pure tool-call) text.
        if (text) {
          await engine.emit("message", {
            message_id: ev.run_id,
            channel: hasToolCalls(msg) ? "reasoning" : "answer",
            text,
          });
        }
        break;
      }
      case "on_tool_start":
        await engine.emit("tool_call", { tool_call_id: ev.run_id, name: ev.name, args: ev.data?.input ?? null });
        break;
      case "on_tool_end":
        await engine.emit("tool_result", { tool_call_id: ev.run_id, name: ev.name, result: summarizeOutput(ev.data?.output) });
        break;
      default:
        break;
    }
  }
}

module.exports = { pump, extractText };
