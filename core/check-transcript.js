#!/usr/bin/env node
// Verify on YOUR machine what the transcript recorded for the last permission prompt.
//   node check-transcript.js
const fs = require("fs");
const path = require("path");
const { findToolResult } = require("./transcript");

const events = fs.readFileSync(path.join(__dirname, "..", "spike", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pi = events.map((e) => e.notification_type).lastIndexOf("permission_prompt");
if (pi < 0) { console.log("No permission_prompt in the capture."); process.exit(0); }
const n = events[pi];
const pre = events.slice(0, pi).reverse().find((e) => e.session_id === n.session_id && e.hook_event_name === "PreToolUse");
const tp = n.transcript_path || pre?.transcript_path;
console.log(`session ${n.session_id.slice(0, 8)}  tool ${pre?.tool_name}  ${pre?.tool_use_id}\ntranscript ${tp}\n`);
const text = fs.readFileSync(tp, "utf8");
console.log("findToolResult →", findToolResult(text, pre.tool_use_id));
console.log("\nRaw transcript lines mentioning this tool_use_id (trimmed):");
for (const l of text.split("\n").filter((x) => x.includes(pre.tool_use_id))) console.log(" ", l.slice(0, 600), "\n");
