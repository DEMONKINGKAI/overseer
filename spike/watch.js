#!/usr/bin/env node
// Overseer spike: live, readable view of events.jsonl.
// Usage: node watch.js          (follow)
//        node watch.js --all    (print history first)
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "events.jsonl");

const C = { dim: "\x1b[2m", reset: "\x1b[0m", green: "\x1b[32m", amber: "\x1b[33m", blue: "\x1b[34m", red: "\x1b[31m", cyan: "\x1b[36m", mag: "\x1b[35m" };
const color = {
  SessionStart: C.green, SessionEnd: C.dim, UserPromptSubmit: C.cyan,
  PreToolUse: C.reset, PostToolUse: C.dim, Notification: C.amber,
  Stop: C.blue, SubagentStop: C.mag, PreCompact: C.red,
};

function summary(e) {
  const t = e.tool_input || {};
  switch (e.hook_event_name) {
    case "PreToolUse":
    case "PostToolUse":
      return `${e.tool_name} ${t.command || t.file_path || t.pattern || t.description || t.url || ""}`.slice(0, 100);
    case "UserPromptSubmit": return `"${(e.prompt || "").slice(0, 80)}"`;
    case "Notification": return `⚠ [${e.notification_type || "?"}] ${e.message || ""}`;
    case "SessionStart": return `source=${e.source || "?"}  model=${e.model || "?"}`;
    case "SessionEnd": return `reason=${e.reason || "?"}  cwd=${e.cwd || ""}`;
    case "PreCompact": return `trigger=${e.trigger || "?"}`;
    case "PreCompact": return `trigger=${e.trigger || "?"}`;
    default: return "";
  }
}

function print(line) {
  if (!line.trim()) return;
  let e; try { e = JSON.parse(line); } catch { return; }
  const ev = e.hook_event_name || e.argv_event || "?";
  const sid = (e.session_id || "????????").slice(0, 8);
  const time = e.ts ? new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false }) : "--:--:--";
  const proj = (e.cwd || "").split(/[\\/]/).filter(Boolean).pop() || "";
  console.log(`${C.dim}${time}${C.reset} ${sid} ${C.dim}${proj.slice(0,14).padEnd(14)}${C.reset} ${color[ev] || ""}${ev.padEnd(17)}${C.reset} ${summary(e)}`);
}

if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "");
let pos = process.argv.includes("--all") ? 0 : fs.statSync(FILE).size;
let buf = "";
function readNew() {
  const size = fs.statSync(FILE).size;
  if (size < pos) pos = 0; // file was cleared
  if (size === pos) return;
  const fd = fs.openSync(FILE, "r");
  const chunk = Buffer.alloc(size - pos);
  fs.readSync(fd, chunk, 0, chunk.length, pos);
  fs.closeSync(fd);
  pos = size;
  buf += chunk.toString("utf8");
  const lines = buf.split("\n");
  buf = lines.pop();
  lines.forEach(print);
}
readNew();
setInterval(readNew, 300);
console.log(`${C.dim}watching ${FILE} … (Ctrl+C to quit)${C.reset}`);
