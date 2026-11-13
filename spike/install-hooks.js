#!/usr/bin/env node
// Overseer spike: merge logging hooks into ~/.claude/settings.json
//   node install-hooks.js            install (idempotent, keeps your existing hooks)
//   node install-hooks.js --remove   remove only Overseer's hooks
const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const LOGGER = path.join(__dirname, "log-event.js").replace(/\\/g, "/");
const TAG = "overseer-spike"; // marker to find our hooks later
const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
                "Notification", "Stop", "SubagentStop", "PreCompact"];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const remove = process.argv.includes("--remove");

let settings = {};
if (fs.existsSync(SETTINGS)) {
  const text = fs.readFileSync(SETTINGS, "utf8");
  try { settings = text.trim() ? JSON.parse(text) : {}; }
  catch (e) { console.error(`✗ ${SETTINGS} isn't valid JSON — fix it first.\n  ${e.message}`); process.exit(1); }
  const backup = `${SETTINGS}.bak-${Date.now()}`;
  fs.copyFileSync(SETTINGS, backup);
  console.log(`• backup: ${backup}`);
} else {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
}

settings.hooks = settings.hooks || {};
const isOurs = (h) => typeof h.command === "string" && h.command.includes(TAG);

// strip any previous Overseer entries (makes install idempotent, and is the whole of --remove)
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = (settings.hooks[ev] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
}

if (!remove) {
  for (const ev of EVENTS) {
    const group = { hooks: [{ type: "command", command: `node "${LOGGER}" ${ev} --${TAG}`, timeout: 5 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = "*";
    (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
  }
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log(remove ? `✓ Overseer hooks removed from ${SETTINGS}`
                   : `✓ ${EVENTS.length} Overseer hooks installed in ${SETTINGS}\n  Restart Claude Code sessions, then run: node watch.js`);
