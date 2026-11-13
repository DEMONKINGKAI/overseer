#!/usr/bin/env node
// Overseer spike: log every Claude Code hook event to events.jsonl.
// Rules: never block Claude Code, never fail. Always exit 0.
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "events.jsonl");
const MAX_STR = 1500; // keep the log readable

function trim(v) {
  if (typeof v === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) + `…[+${v.length - MAX_STR} chars]` : v;
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = trim(x);
    return o;
  }
  return v;
}

let raw = "";
const done = () => {
  try {
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { _unparsed: raw }; }
    const line = JSON.stringify({ ts: new Date().toISOString(), argv_event: process.argv[2] || null, ...trim(payload) });
    fs.appendFileSync(OUT, line + "\n");
  } catch (_) { /* swallow everything */ }
  process.exit(0);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", done);
setTimeout(done, 2000); // safety net if stdin never closes
