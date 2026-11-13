// Overseer core: read a session transcript (JSONL) to learn things hooks don't report.
// Used for: a denied permission prompt fires no hook at all — but the transcript records
// a tool_result for that tool_use_id, so the app checks it while a session is 🟠.

// Returns null (no result yet), or { toolUseId, outcome: "rejected" | "error" | "ok", text }
function findToolResult(jsonlText, toolUseId) {
  const lines = jsonlText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(toolUseId)) continue; // cheap filter before parsing
    let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== "tool_result" || c.tool_use_id !== toolUseId) continue;
      const text = typeof c.content === "string" ? c.content
        : Array.isArray(c.content) ? c.content.map((x) => x?.text || "").join(" ") : "";
      const rejected = /doesn't want to proceed|was rejected|user (denied|rejected)|permission (was )?denied/i.test(text);
      return { toolUseId, outcome: rejected ? "rejected" : c.is_error ? "error" : "ok", text: text.slice(0, 200) };
    }
  }
  return null;
}

// Turn a transcript finding into a synthetic event the reducer understands.
function toEvent(sessionId, result, ts = new Date().toISOString()) {
  if (!result) return null;
  return { ts, session_id: sessionId, hook_event_name: "ToolResolved", tool_use_id: result.toolUseId, outcome: result.outcome, source: "transcript" };
}

const transcriptApi = { findToolResult, toEvent };
if (typeof module !== "undefined" && module.exports) module.exports = transcriptApi;
else globalThis.OverseerTranscript = transcriptApi;
