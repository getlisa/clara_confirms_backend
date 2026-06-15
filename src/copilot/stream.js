/**
 * Map LangGraph streamEvents → engine/broker events (the SSE wire protocol).
 *
 * Token deltas are HIGH volume, so we publish them straight to the in-memory
 * broker (live-only, not persisted) to keep engine_runs.state_history small.
 * Low-volume milestones (tool_call, tool_result) go through engine.emit so they
 * ARE persisted and replay on reconnect. The final assistant text is persisted
 * in the terminal `done` event by the orchestrator.
 */

const broker = require("../engines/core/broker");

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
 * Consume a graph streamEvents iterator, emitting tokens + tool events.
 * Returns the concatenated assistant text streamed during the turn.
 */
async function pump(engine, events) {
  const runId = String(engine.id);
  for await (const ev of events) {
    switch (ev.event) {
      case "on_chat_model_stream": {
        const text = extractText(ev.data?.chunk);
        if (text) broker.publish(runId, { type: "token", payload: { text } });
        break;
      }
      case "on_tool_start":
        await engine.emit("tool_call", { name: ev.name, args: ev.data?.input ?? null });
        break;
      case "on_tool_end":
        await engine.emit("tool_result", { name: ev.name, result: summarizeOutput(ev.data?.output) });
        break;
      default:
        break;
    }
  }
}

module.exports = { pump, extractText };
