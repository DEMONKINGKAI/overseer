#!/usr/bin/env node
// Overseer's interactive hooks — the deliberate exception to "hooks never block" (see DESIGN.md).
//
//   node ask.js permission   PermissionRequest: hold the approval prompt so the widget can Allow / Deny
//   node ask.js question     PreToolUse(AskUserQuestion): let the widget pick an answer or type one
//   node ask.js stop         Stop: deliver a follow-up queued in the widget (fast check, never waits)
//
// Safety rules:
//   • Only waits if the Overseer app is running; if it isn't, exits at once and Claude Code shows its normal prompt.
//   • Waits at most ASK_TIMEOUT; on timeout, or "Answer in terminal", prints nothing → normal terminal prompt.
//   • Any error → print nothing, exit 0.
const { readStdin, slim, request, sendEvent } = require("./lib");

const mode = process.argv[2];
const ASK_TIMEOUT_MS = 125e3; // app releases at 120 s; hook config timeout is 130 s

let finished = false;
const finish = (output) => {
  if (finished) return;
  finished = true;
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
};
setTimeout(() => finish(), mode === "stop" ? 2500 : ASK_TIMEOUT_MS + 3000).unref();

function ask(payload, kind, toOutput) {
  const body = { ts: new Date().toISOString(), ...slim(payload), ask_kind: kind };
  request("POST", "/ask", body, ASK_TIMEOUT_MS, (err, status, text) => {
    if (err || status !== 200) return finish();
    let reply; try { reply = JSON.parse(text); } catch { return finish(); }
    finish(toOutput(reply));
  });
}

readStdin((raw) => {
  let p;
  try { p = JSON.parse(raw); } catch { return finish(); }

  if (mode === "permission") {
    // these need real user interaction in the terminal (or come through the question path)
    if (["AskUserQuestion", "ExitPlanMode"].includes(p.tool_name)) return finish();
    return ask(p, "permission", (r) => {
      if (r.outcome === "allow") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
      if (r.outcome === "deny") return { hookSpecificOutput: { hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: r.message || "The user denied this from Overseer." } } };
      return null; // terminal / timeout
    });
  }

  if (mode === "question") {
    if (p.tool_name !== "AskUserQuestion") return finish();
    return ask(p, "question", (r) => {
      if (r.outcome !== "answered" || !r.answers) return null;
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
        updatedInput: { ...(p.tool_input || {}), answers: r.answers } } };
    });
  }

  if (mode === "stop") {
    // Stop also needs to be reported as an event (this hook replaces emit.js for Stop, so ordering is guaranteed).
    const report = (followup) => sendEvent({ ts: new Date().toISOString(), ...slim(p), ...(followup ? { followup_delivered: followup } : {}) },
      () => finish(followup ? { decision: "block", reason: `Follow-up from the user, queued in the Overseer widget while you were working (not an error):\n\n${followup}` } : null));
    if (p.agent_id) return report(null);
    return request("GET", `/followup?session=${encodeURIComponent(p.session_id || "")}`, null, 600, (err, status, text) => {
      let msg = null;
      if (!err && status === 200) { try { msg = JSON.parse(text).message || null; } catch {} }
      report(msg);
    });
  }

  finish();
});
