# Overseer — Spike 1: see the raw hook events

Goal: before designing anything, watch what Claude Code actually emits across real sessions.

## Files
- `log-event.js` — hook handler. Appends each event (with timestamp) to `events.jsonl`. Always exits 0, never blocks.
- `watch.js` — live, colour-coded view of the event stream.
- `install-hooks.js` — merges the hooks into your Claude Code settings (backs up first, keeps existing hooks). `--remove` undoes it.
- `hooks-settings.json` — the same config, for reference.

## Setup (2 min)
1. Run `node install-hooks.js` (in this folder).
2. Restart any running Claude Code sessions (hooks load at session start).
3. In a separate terminal: `node watch.js`

## What to try
Run 2–3 sessions in parallel and deliberately trigger:
- [ ] a normal prompt → tools → finish (`Stop`)
- [ ] a **permission prompt** (e.g. a Bash command not on your allowlist) → does `Notification` fire? what's the message?
- [ ] leave a session idle after finishing → does a second `Notification` ("waiting for input") arrive later?
- [ ] a task that spawns a **subagent** → what does the Task/Agent `PreToolUse` look like, and does `SubagentStop` carry anything linking it back?
- [ ] `/compact`, `/clear`, exit, and `claude --resume` → check `SessionStart.source` / `SessionEnd.reason`
- [ ] Ctrl+C / interrupt mid-tool → which events do (and don't) arrive? (this is the stale-detection case)

## Questions this spike must answer
1. Can we reliably tell "needs permission" apart from "idle, waiting for input"?
2. Can subagent events be tied to their parent tool call?
3. What gets lost on interrupt or crash (→ how aggressive does stale detection need to be)?
4. Hook latency: does logging add any noticeable lag?

Then: `node watch.js --all > findings.txt` and we design the state machine from real data.

## Removing it
Delete the hooks block from `settings.json`.
