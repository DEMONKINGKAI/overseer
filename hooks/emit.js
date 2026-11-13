#!/usr/bin/env node
// Overseer hook emitter (non-blocking). Claude Code runs this for every hook event.
// Contract (D-5): never slow or break Claude Code — fire-and-forget, short timeout, always exit 0.
const { readStdin, slim, sendEvent } = require("./lib");

let finished = false;
const finish = () => { if (!finished) { finished = true; process.exit(0); } };
setTimeout(finish, 1500).unref();

readStdin((raw) => {
  let payload;
  try { payload = JSON.parse(raw); } catch { return finish(); }
  sendEvent({ ts: new Date().toISOString(), ...slim(payload) }, finish);
});
