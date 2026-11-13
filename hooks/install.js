#!/usr/bin/env node
// Install Overseer's hooks into ~/.claude/settings.json (every Claude Code session on this machine).
//   node install.js            install / update (idempotent; keeps your other hooks)
//   node install.js --remove   remove Overseer's hooks
//   node install.js --watch-only   install without widget answering (no blocking hooks)
const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const dir = __dirname.replace(/\\/g, "/");
const TAG = "overseer-hook";
const OLD_TAGS = ["overseer-spike"];
const remove = process.argv.includes("--remove");
const watchOnly = process.argv.includes("--watch-only");

const cmd = (script, arg = "") => ({ type: "command", command: `node "${dir}/${script}"${arg ? " " + arg : ""} --${TAG}` });
const PLAN = [
  ["SessionStart", null, cmd("emit.js"), 3],
  ["SessionEnd", null, cmd("emit.js"), 3],
  ["UserPromptSubmit", null, cmd("emit.js"), 3],
  ["PreToolUse", "*", cmd("emit.js"), 3],
  ["PostToolUse", "*", cmd("emit.js"), 3],
  ["Notification", null, cmd("emit.js"), 3],
  ["Stop", null, cmd("ask.js", "stop"), 5],          // reports Stop + delivers queued follow-ups
  ["SubagentStop", null, cmd("emit.js"), 3],
  ["PreCompact", null, cmd("emit.js"), 3],
  ...(watchOnly ? [] : [
    ["PermissionRequest", "*", cmd("ask.js", "permission"), 130],
    ["PreToolUse", "AskUserQuestion", cmd("ask.js", "question"), 130],
  ]),
];

let settings = {};
if (fs.existsSync(SETTINGS)) {
  const text = fs.readFileSync(SETTINGS, "utf8");
  try { settings = text.trim() ? JSON.parse(text) : {}; }
  catch (e) { console.error(`✗ ${SETTINGS} isn't valid JSON — fix it first.\n  ${e.message}`); process.exit(1); }
  const backup = `${SETTINGS}.bak-${Date.now()}`;
  fs.copyFileSync(SETTINGS, backup);
  console.log(`• backup: ${backup}`);
} else fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });

settings.hooks = settings.hooks || {};
const ours = (h) => typeof h.command === "string" && [TAG, ...OLD_TAGS].some((t) => h.command.includes(t));
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = (settings.hooks[ev] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
    .filter((g) => g.hooks.length > 0);
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}
if (!remove) for (const [ev, matcher, hook, timeout] of PLAN) {
  const group = { hooks: [{ ...hook, timeout }] };
  if (matcher) group.matcher = matcher;
  (settings.hooks[ev] ||= []).push(group);
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log(remove ? "✓ Overseer hooks removed."
  : `✓ Overseer hooks installed${watchOnly ? " (watch-only)" : " (with widget answering)"}. Restart Claude Code sessions to pick them up.`);
