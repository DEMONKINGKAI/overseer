#!/usr/bin/env node
// Replay a captured events.jsonl through the reducer and show what Overseer would display.
//   node replay.js [path/to/events.jsonl] [--steps]
const fs = require("fs");
const path = require("path");
const { initialState, reduce, tick, view } = require("./state");

const file = process.argv.find((a) => a.endsWith(".jsonl")) || path.join(__dirname, "..", "spike", "events.jsonl");
const steps = process.argv.includes("--steps");
const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const icon = { permission: "🟠", your_move: "🔵", stale: "⚠️ ", working: "🟢", ended: "⚫" };

let s = initialState();
for (const e of events) {
  s = reduce(s, e);
  if (steps) {
    const x = s.sessions[e.session_id];
    if (x) console.log(`${e.ts.slice(11, 19)} ${e.session_id.slice(0, 8)} ${(e.hook_event_name || "").padEnd(16)} → ${icon[x.status]} ${x.status.padEnd(10)} ${x.activity}`);
  }
}
const end = Date.parse(events.at(-1).ts);
const now = process.argv.includes("--later") ? end + 30 * 60e3 : end + 1000;
s = tick(s, now);
const v = view(s, now);
console.log(`\nTray: ${v.tray}  badge: ${v.badge ?? "-"}  needs you: ${v.needsYou}`);
for (const r of v.rows) {
  console.log(`${icon[r.status]} ${r.project.padEnd(12)} ${r.id.slice(0, 8)}  ${r.activity}`);
  for (const a of r.agents) console.log(`     └ ${a.status === "running" ? "🟢" : "✓"} ${a.type || "agent"} ${a.id.slice(0, 8)}  ${a.activity}`);
}
