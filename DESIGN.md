# Overseer — design

> Your agents have an Overseer now.

Overseer is a tray/menu-bar widget that shows every local Claude Code session at a glance: what each one is doing, and **which ones need you**.
v1 covers local Claude Code only. claude.ai chats and Cowork run in the cloud with no live-state API, so they are out of scope.

## Architecture

```
Claude Code ──hooks──▶ overseer-emit ──HTTP POST──▶ Overseer app (Tauri)
 (each session)        tiny, fire-and-forget         ├─ Rust shell: localhost receiver, spool replay, tray icon, OS notifications
                       spools to a file if the       └─ Web UI: core/state.js reducer → session list
                       app isn't running
```

- **Hooks never slow or break Claude Code.** They fire and forget, use a short timeout and always exit 0. If the app is down, events go to a spool file that the app replays on launch.
- **All logic lives in `core/state.js`.** It's a pure reducer with no dependencies. The Rust side only receives events and passes them along, so the state machine stays testable in Node and is shared with the UI as-is.

## Session states

| State | Icon | Meaning | Entered by |
|---|---|---|---|
| `permission` | 🟠 | Blocked on an approval prompt | `Notification` with `notification_type: "permission_prompt"` |
| `your_move` | 🔵 | Turn finished, nothing running | `Stop` with no open tools, no running subagents and empty `background_tasks`; or `Notification` `idle_prompt` |
| `working` | 🟢 | Tools running, model thinking, or background agents busy | `UserPromptSubmit`, `PreToolUse`, `PreCompact`, or `Stop` while background work remains |
| `stale` | ⚠️ | Says working but has gone silent | `tick()`: unpaired tool past its grace period, or no events for 4 min |
| `ended` | ⚫ | Session closed | `SessionEnd`, shown for 10 min, then dropped |

Urgency order (sorting and tray colour): permission → your_move → stale → working → ended.
Tray: **amber** = approval needed (badge = count) · **blue** = something is your move · **warn** = possibly stuck · **active** = all busy · **calm** = nothing running.

## Rules that came from the spike data

1. **Permission vs idle** is read from `Notification.notification_type` (`permission_prompt` / `idle_prompt`). The message text isn't used.
2. **The `PostToolUse` after a permission prompt clears it.** This is the same `tool_use_id`, approved.
3. **`Stop` ≠ idle.** Background subagents keep running after the parent stops. `Stop.background_tasks` and open `agent_id`s keep the session `working`.
4. **Subagent nesting:** every event from a subagent carries `agent_id` and `agent_type`. `SubagentStop` closes it.
5. **Hidden helpers:** subagents with an empty `agent_type` and no tool calls are internal (they show up right after `Stop`), so they're hidden.
6. **Interrupts send no closing event** (Esc mid-tool gives a `PreToolUse` with no `PostToolUse` and no `Stop`). Handling:
   - A new real `UserPromptSubmit` clears the main agent's unpaired tools.
   - Otherwise `tick()` marks the session stale once every open tool is past its grace period: Bash/PowerShell 10 min, Agent/Task 30 min, others 3 min.
7. **Headless runs** (`claude -p` from plugins such as decision-graph) start and end within seconds. Sessions shorter than 15 s are hidden.
8. **`<agent-message …>` prompts** are subagent hand-backs, not the user, so they don't clear open tools.
9. **Denied permission prompts are silent in hooks**: no `PostToolUse`, no `Stop`, no later `idle_prompt` (watched for 3 min). While a session is 🟠, the app checks its transcript (`transcript_path`) for a `tool_result` matching the pending `tool_use_id` (`core/transcript.js`). A rejection becomes a synthetic `ToolResolved` event → 🔵 "Denied — your move". `transcriptWatchList(state)` tells the app which files to check.
10. **Free extras:** `SessionStart.model`, `Stop.last_assistant_message` (row summary), `prompt_id` (groups a turn), `PostToolUse` duration.

## Answering from the widget (the one exception to "hooks never block")

D-5 still holds for every observing hook (`hooks/emit.js`). The exception is `hooks/ask.js`, which Kai approved on 2026-11-13:

| Hook | Mode | What the widget can do | Hook output |
|---|---|---|---|
| `PermissionRequest` (matcher `*`) | `ask.js permission` | Allow / Deny (with an optional message to Claude) / Answer in terminal | `decision.behavior` allow or deny |
| `PreToolUse` (matcher `AskUserQuestion`) | `ask.js question` | Pick options or type a custom answer | `permissionDecision: "allow"` + `updatedInput` = original questions + `answers` |
| `Stop` | `ask.js stop` | Deliver a follow-up queued while Claude was working | `decision: "block"`, `reason` = the message, so Claude continues |

Safety rules:
- The hook only waits if the app answers on `127.0.0.1:47321`. If the app isn't running, it exits within about 70 ms and the normal terminal prompt appears.
- The app releases a held prompt after **120 s**, or right away on "Answer in terminal". The hook then prints nothing, so Claude Code shows its own prompt.
- `ExitPlanMode` is never held, so it always goes to the terminal.
- `Stop` never waits: it's a 600 ms check for a queued message, then it reports the Stop event (this replaces `emit.js` for Stop, so ordering is guaranteed).
- `node hooks/install.js --watch-only` installs Overseer without any blocking hooks.

App side: `/ask` long-polls, so the server is one thread per request. Each held prompt is an `AskOpened` event; the answer (or timeout) is an `AskResolved` event. Follow-ups are `FollowupQueued` / `FollowupCancelled`, and the Stop event carries `followup_delivered`.

**Not possible:** sending a message to a session that's already idle at its prompt. No hook fires there, so nothing can type into that terminal. That needs Overseer-launched sessions (v2 idea).

**Still to verify on a real session:** whether the terminal shows its own prompt while `ask.js` is waiting, or sits blank until the widget answers.

## Hook events used

`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` (matcher `*`), `Notification`, `Stop`, `SubagentStop`, `PreCompact`.
Common fields: `session_id`, `cwd`, `transcript_path`, `permission_mode`, `prompt_id`; subagent events add `agent_id`, `agent_type`.

## Known gaps (v1)

- A Bash command interrupted with Esc shows `working` for up to 10 min before going stale. Shortening that would flag long builds wrongly. A later fix is to watch the transcript JSONL for the interrupt marker.
- Hook payload fields can change between Claude Code versions. `spike/` stays in the repo for recapturing.

## Layout

```
spike/   capture tooling (logger, viewer, installer) + events.jsonl
core/    state.js (reducer), state.test.js (node --test), replay.js (run a capture through it)
hooks/   emit.js (the hook: POST to 127.0.0.1:47321, spool to ~/.overseer/spool.jsonl) + install.js
app/     src-tauri/ (Rust: receiver, spool replay, tray, transcript reads) + ui/ (widget; core/ synced in)
```
