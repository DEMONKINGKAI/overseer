# Overseer

> Your agents have an Overseer now.

A tray widget that shows every local Claude Code session at a glance: what each one is doing, and which ones need you.

🟠 needs approval · 🔵 your move · 🟢 working · ⚠️ gone quiet · ⚫ ended

## Run it (Windows / macOS)

Requirements: Node 18+, Rust (`rustc --version`), and on Windows the VS C++ build tools.

```
cd app
npm install
npm run dev          # first build compiles Rust and takes a few minutes
```

Then install the hooks once (this replaces the spike logger, and keeps your other hooks):

```
node hooks/install.js
```

Restart your Claude Code sessions. Closing the window hides it to the tray. **Quit Overseer** in the tray menu exits.
Click a session to copy its `claude --resume <id>` command.

`npm run build` produces an installer in `app/src-tauri/target/release/bundle/`.

## How it works

Claude Code hooks → `hooks/emit.js` → `127.0.0.1:47321` → Tauri app → `core/state.js` → UI.
If the app isn't running, events are spooled to `~/.overseer/spool.jsonl` and replayed on launch.
See [DESIGN.md](DESIGN.md) for the states and the rules behind them.

## Layout

| Folder | What |
|---|---|
| `core/` | State machine (pure JS, shared with the UI). `node --test` in `core/` runs the tests |
| `hooks/` | `emit.js` (the hook) and `install.js` (adds or removes it in `~/.claude/settings.json`) |
| `app/` | Tauri app: `src-tauri/` (Rust shell, tray, event receiver) and `ui/` (widget) |
| `spike/` | Capture tooling used to design the state machine. Keep it for re-checking new Claude Code versions |

Uninstall the hooks: `node hooks/install.js --remove`.
