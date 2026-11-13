// node --test   (from the core folder)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initialState, reduce, tick, view, STATUS, transcriptWatchList } = require("./state");

const T0 = Date.parse("2026-11-13T10:00:00Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const ev = (sec, hook_event_name, extra = {}) => ({ ts: at(sec), session_id: "S1", cwd: "C:/code/Threadfall", hook_event_name, ...extra });
const run = (events) => events.reduce(reduce, initialState());
const S = (st) => st.sessions.S1;

test("normal turn: prompt → tool → stop = your move", () => {
  const st = run([ev(0, "SessionStart", { source: "startup", model: "claude-opus-5-5" }), ev(1, "UserPromptSubmit", { prompt: "hi" }),
    ev(2, "PreToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: "C:/code/Threadfall/src/engine.ts" } })]);
  assert.equal(S(st).status, STATUS.WORKING);
  assert.equal(S(st).activity, "Reading engine.ts");
  const done = run([ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "hi" }),
    ev(2, "PreToolUse", { tool_name: "Read", tool_use_id: "t1" }), ev(3, "PostToolUse", { tool_name: "Read", tool_use_id: "t1" }),
    ev(5, "Stop", { last_assistant_message: "Done.", background_tasks: [] })]);
  assert.equal(S(done).status, STATUS.YOUR_MOVE);
  assert.equal(S(done).lastMessage, "Done.");
  assert.equal(S(done).project, "Threadfall");
});

test("permission prompt → amber, approval → working", () => {
  const base = [ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "curl" }),
    ev(2, "PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "curl -s https://example.com" } }),
    ev(8, "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission" })];
  const st = run(base);
  assert.equal(S(st).status, STATUS.PERMISSION);
  assert.match(S(st).activity, /Needs approval: Running curl/);
  assert.equal(view(st, T0 + 9e3).tray, "amber");
  assert.equal(view(st, T0 + 9e3).badge, 1);
  const approved = run([...base, ev(20, "PostToolUse", { tool_name: "Bash", tool_use_id: "t1" })]);
  assert.equal(S(approved).status, STATUS.WORKING);
  assert.equal(S(approved).activity, "Thinking");
});

test("idle_prompt notification = your move, not permission", () => {
  const st = run([ev(0, "SessionStart"), ev(60, "Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" })]);
  assert.equal(S(st).status, STATUS.YOUR_MOVE);
});

test("background subagent: turn ended = your move (with a note); SubagentStop clears the note", () => {
  const A = { agent_id: "A1", agent_type: "general-purpose" };
  const mid = run([ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "delegate" }),
    ev(2, "PreToolUse", { tool_name: "Agent", tool_use_id: "t1" }), ev(2, "PostToolUse", { tool_name: "Agent", tool_use_id: "t1" }),
    ev(3, "Stop", { background_tasks: [{ id: "x" }] }),
    ev(4, "PreToolUse", { tool_name: "Glob", tool_use_id: "t2", tool_input: { pattern: "**/*" }, ...A })]);
  assert.equal(S(mid).status, STATUS.YOUR_MOVE);
  assert.match(S(mid).activity, /background task running/);
  assert.equal(S(mid).agents.A1.activity, "Searching **/*");
  const done = [ev(5, "PostToolUse", { tool_name: "Glob", tool_use_id: "t2", ...A }), ev(9, "SubagentStop", A)].reduce(reduce, mid);
  assert.equal(S(done).status, STATUS.YOUR_MOVE);
  assert.equal(S(done).activity, "Done — your move");
  assert.equal(view(done, T0 + 10e3).rows[0].agents[0].status, "done");
});

test("fork subagents that never send SubagentStop don't leave the session stuck", () => {
  const F = { agent_id: "F1", agent_type: "fork" };
  const st = run([ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "check" }),
    ev(2, "PreToolUse", { tool_name: "Bash", tool_use_id: "g", tool_input: { command: "grep -rn import ." }, ...F }),
    ev(30, "Stop", { background_tasks: [] })]);
  assert.equal(S(st).agents.F1.status, "done", "empty background_tasks closes leftover agents");
  assert.equal(S(st).activity, "Done — your move");
  // no Stop info at all: the silent agent is retired by tick after 10 min
  const st2 = run([ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "check" }),
    ev(2, "PreToolUse", { tool_name: "Bash", tool_use_id: "g", ...F }), ev(30, "Stop")]);
  assert.match(S(st2).activity, /background task running/);
  const later = tick(st2, T0 + 15 * 60e3);
  assert.equal(later.sessions.S1.agents.F1.status, "done");
  assert.equal(later.sessions.S1.activity, "Done — your move");
});

test("internal helper agents (empty type, no tools) are hidden", () => {
  const st = run([ev(0, "SessionStart"), ev(1, "Stop", { background_tasks: [] }), ev(2, "SubagentStop", { agent_id: "H", agent_type: "" })]);
  assert.equal(S(st).status, STATUS.YOUR_MOVE);
  assert.equal(view(st, T0 + 3e3).rows[0].agents.length, 0);
});

test("interrupt: unpaired tool goes stale; a new prompt clears it", () => {
  const st = run([ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "ping" }),
    ev(2, "PreToolUse", { tool_name: "Read", tool_use_id: "t1" })]);
  assert.equal(tick(st, T0 + 60e3).sessions.S1.status, STATUS.WORKING);
  const stale = tick(st, T0 + 10 * 60e3);
  assert.equal(stale.sessions.S1.status, STATUS.STALE);
  const revived = reduce(stale, ev(700, "UserPromptSubmit", { prompt: "again" }));
  assert.equal(Object.keys(S(revived).openTools).length, 0);
  assert.equal(S(revived).status, STATUS.WORKING);
});

test("long shell commands get a longer grace period than reads", () => {
  const st = run([ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "build" }),
    ev(2, "PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm run build" } })]);
  assert.equal(tick(st, T0 + 5 * 60e3).sessions.S1.status, STATUS.WORKING);
  assert.equal(tick(st, T0 + 11 * 60e3).sessions.S1.status, STATUS.STALE);
});

test("headless runs (start→end in seconds) are hidden; ended sessions expire", () => {
  const st = run([ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "extract" }), ev(2, "Stop"), ev(3, "SessionEnd", { reason: "other" })]);
  assert.equal(view(st, T0 + 4e3).rows.length, 0);
  const long = run([ev(0, "SessionStart"), ev(5, "UserPromptSubmit", { prompt: "hi" }), ev(100, "SessionEnd", { reason: "prompt_input_exit" })]);
  assert.equal(view(long, T0 + 101e3).rows[0].status, STATUS.ENDED);
  assert.equal(Object.keys(tick(long, T0 + 100e3 + 11 * 60e3).sessions).length, 0);
});

test("urgency ordering: permission, then your move, then working", () => {
  let st = initialState();
  const mk = (id, evs) => evs.forEach((e) => (st = reduce(st, { ...e, session_id: id })));
  mk("W", [ev(0, "SessionStart"), ev(1, "UserPromptSubmit", { prompt: "x" })]);
  mk("Y", [ev(0, "SessionStart"), ev(1, "Stop")]);
  mk("P", [ev(0, "SessionStart"), ev(1, "PreToolUse", { tool_name: "Bash", tool_use_id: "b" }), ev(2, "Notification", { notification_type: "permission_prompt" })]);
  assert.deepEqual(view(st, T0 + 3e3).rows.map((r) => r.id), ["P", "Y", "W"]);
});

test("replays the real spike capture without errors", (t) => {
  const file = path.join(__dirname, "..", "spike", "events.jsonl");
  if (!fs.existsSync(file)) return t.skip("no capture");
  const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const st = events.reduce(reduce, initialState());
  const v = view(st, Date.parse(events.at(-1).ts) + 1000);
  assert.ok(v.rows.every((r) => r.status));
  assert.ok(!v.rows.some((r) => r.id.startsWith("74f0a601")), "headless decision-graph run should be hidden");
});

test("denied permission: silent in hooks, resolved from the transcript", () => {
  const { findToolResult, toEvent } = require("./transcript");
  const { transcriptWatchList } = require("./state");
  const st = run([ev(0, "SessionStart", { transcript_path: "C:/t/S1.jsonl" }), ev(1, "UserPromptSubmit", { prompt: "curl" }),
    ev(2, "PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_X", tool_input: { command: "curl x" } }),
    ev(8, "Notification", { notification_type: "permission_prompt" })]);
  assert.equal(S(st).status, STATUS.PERMISSION);
  assert.deepEqual(transcriptWatchList(st), [{ sessionId: "S1", transcriptPath: "C:/t/S1.jsonl", toolUseId: "toolu_X" }]);
  const transcript = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_X", name: "Bash" }] } }),
    // verbatim shape from a real Claude Code transcript (denied curl, 2026-11-13)
    JSON.stringify({ parentUuid: "7cd5add1", isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result",
      content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
      is_error: true, tool_use_id: "toolu_X" }] }, timestamp: "2026-11-13T18:57:25.493Z" }),
  ].join("\n");
  const found = findToolResult(transcript, "toolu_X");
  assert.equal(found.outcome, "rejected");
  const after = reduce(st, toEvent("S1", found, at(30)));
  assert.equal(S(after).status, STATUS.YOUR_MOVE);
  assert.equal(S(after).activity, "Denied — your move");
  assert.equal(transcriptWatchList(after).length, 0);
});

test("transcript: no result yet → null; normal result → ok", () => {
  const { findToolResult } = require("./transcript");
  assert.equal(findToolResult('{"type":"assistant"}', "toolu_Y"), null);
  const ok = JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "toolu_Y", content: [{ type: "text", text: "<html>" }] }] } });
  assert.equal(findToolResult(ok, "toolu_Y").outcome, "ok");
});

// ---------- v2: plans, timeline, terminal, asks, follow-ups ----------
const start = [ev(0, "SessionStart", { model: "claude-opus-5-5" }), ev(1, "UserPromptSubmit", { prompt: "make the deck" })];

test("TodoWrite drives progress and the current step label", () => {
  const st = run([...start, ev(2, "PreToolUse", { tool_name: "TodoWrite", tool_use_id: "w", tool_input: { todos: [
    { content: "Read outline", status: "completed", activeForm: "Reading outline" },
    { content: "Draft slides", status: "in_progress", activeForm: "Drafting slides" },
    { content: "Export", status: "pending", activeForm: "Exporting" }] } })]);
  const r = view(st, T0 + 3e3).rows[0];
  assert.deepEqual(r.progress, { done: 1, total: 3, label: "Drafting slides" });
  assert.equal(r.timeline.length, 0, "plan tools don't clutter the timeline");
});

test("TaskCreate/TaskUpdate build the plan (ids from the tool response, else sequential)", () => {
  const st = run([...start,
    ev(2, "PreToolUse", { tool_name: "TaskCreate", tool_use_id: "c1", tool_input: { subject: "Spike hooks", activeForm: "Spiking hooks" } }),
    ev(2, "PostToolUse", { tool_name: "TaskCreate", tool_use_id: "c1", tool_response: "Task #1 created successfully: Spike hooks" }),
    ev(3, "PreToolUse", { tool_name: "TaskCreate", tool_use_id: "c2", tool_input: { subject: "Build UI" } }),
    ev(3, "PostToolUse", { tool_name: "TaskCreate", tool_use_id: "c2" }),
    ev(4, "PreToolUse", { tool_name: "TaskUpdate", tool_use_id: "u1", tool_input: { taskId: "1", status: "completed" } }),
    ev(5, "PreToolUse", { tool_name: "TaskUpdate", tool_use_id: "u2", tool_input: { taskId: "2", status: "in_progress", activeForm: "Building UI" } })]);
  assert.deepEqual(S(st).todos.map((x) => [x.id, x.status]), [["1", "completed"], ["2", "in_progress"]]);
  assert.equal(view(st, T0 + 6e3).rows[0].progress.label, "Building UI");
});

test("timeline + terminal: shell command output tail is kept", () => {
  const st = run([...start,
    ev(2, "PreToolUse", { tool_name: "Read", tool_use_id: "r", tool_input: { file_path: "C:/x/notes.md" } }),
    ev(3, "PostToolUse", { tool_name: "Read", tool_use_id: "r" }),
    ev(4, "PreToolUse", { tool_name: "Bash", tool_use_id: "b", tool_input: { command: "npm test" } })]);
  let r = view(st, T0 + 5e3).rows[0];
  assert.deepEqual(r.timeline.map((x) => [x.kind, x.status]), [["read", "done"], ["terminal", "running"]]);
  assert.equal(r.terminal.running, true);
  const after = reduce(st, ev(9, "PostToolUse", { tool_name: "Bash", tool_use_id: "b", tool_response: { stdout: "line1\nline2\n# pass 12", stderr: "" } }));
  r = view(after, T0 + 10e3).rows[0];
  assert.equal(r.terminal.running, false);
  assert.match(r.terminal.output, /# pass 12/);
});

test("widget-held permission: AskOpened → allow → working", () => {
  const base = [...start, ev(2, "PreToolUse", { tool_name: "Bash", tool_use_id: "b", tool_input: { command: "curl x" } }),
    ev(3, "AskOpened", { request_id: "q1", ask_kind: "permission", tool_name: "Bash", tool_use_id: "b", tool_input: { command: "curl x" } })];
  const st = run(base);
  assert.equal(S(st).status, STATUS.PERMISSION);
  assert.equal(view(st, T0 + 4e3).rows[0].ask.requestId, "q1");
  assert.equal(transcriptWatchList(st).length, 0, "widget-held prompts don't need transcript polling");
  const ok = reduce(st, ev(5, "AskResolved", { request_id: "q1", outcome: "allow" }));
  assert.equal(S(ok).status, STATUS.WORKING);
  const deny = reduce(st, ev(5, "AskResolved", { request_id: "q1", outcome: "deny" }));
  assert.equal(S(deny).status, STATUS.WORKING, "Claude gets the denial message and carries on");
});

test("released to terminal: stays blocked, widget controls disappear, then normal flow", () => {
  const st = run([...start, ev(2, "PreToolUse", { tool_name: "Bash", tool_use_id: "b" }),
    ev(3, "AskOpened", { request_id: "q1", ask_kind: "permission", tool_name: "Bash", tool_use_id: "b" }),
    ev(4, "AskResolved", { request_id: "q1", outcome: "terminal" })]);
  const r = view(st, T0 + 5e3).rows[0];
  assert.equal(r.status, STATUS.PERMISSION);
  assert.equal(r.ask, null);
  assert.equal(r.askReleased, true);
  const approved = reduce(st, ev(9, "PostToolUse", { tool_name: "Bash", tool_use_id: "b" }));
  assert.equal(S(approved).status, STATUS.WORKING);
});

test("AskUserQuestion via widget: question state with options, answered → working", () => {
  const questions = [{ question: "Which hook should I use?", header: "Hook", multiSelect: false,
    options: [{ label: "The pain one" }, { label: "The number one" }] }];
  const st = run([...start, ev(2, "PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "a", tool_input: { questions } }),
    ev(2, "AskOpened", { request_id: "q2", ask_kind: "question", tool_name: "AskUserQuestion", tool_use_id: "a", tool_input: { questions } })]);
  const r = view(st, T0 + 3e3).rows[0];
  assert.equal(r.status, STATUS.QUESTION);
  assert.equal(r.ask.questions[0].options.length, 2);
  assert.equal(view(st, T0 + 3e3).tray, "amber");
  const answered = [ev(4, "AskResolved", { request_id: "q2", outcome: "answered" }), ev(4, "PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "a" })].reduce(reduce, st);
  assert.equal(S(answered).status, STATUS.WORKING);
});

test("follow-up: queued while working, delivered at Stop → turn continues", () => {
  const st = run([...start, ev(2, "FollowupQueued", { message: "also add tests" })]);
  assert.equal(view(st, T0 + 3e3).rows[0].queued, "also add tests");
  const delivered = reduce(st, ev(5, "Stop", { background_tasks: [], followup_delivered: "also add tests" }));
  assert.equal(S(delivered).status, STATUS.WORKING);
  assert.equal(S(delivered).queued, null);
  assert.match(S(delivered).activity, /Following up/);
  const normal = reduce(run([...start, ev(2, "FollowupQueued", { message: "x" }), ev(3, "FollowupCancelled")]), ev(5, "Stop", { background_tasks: [] }));
  assert.equal(S(normal).status, STATUS.YOUR_MOVE);
});

test("numeric timestamps from the app are accepted", () => {
  const st = run([ev(0, "SessionStart"), { session_id: "S1", ts: T0 + 5000, hook_event_name: "FollowupQueued", message: "m" }]);
  assert.equal(S(st).lastEventAt, T0 + 5000);
});

test("sessions that are only opened/resumed get no card until something happens", () => {
  const resumed = run([ev(0, "SessionStart", { source: "resume", model: "claude-opus-5-5" }),
    ev(60, "Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" })]);
  assert.equal(view(resumed, T0 + 61e3).rows.length, 0, "background resume stays hidden");
  const used = reduce(resumed, ev(90, "UserPromptSubmit", { prompt: "continue" }));
  assert.equal(view(used, T0 + 91e3).rows.length, 1, "appears on first real activity");
  const ended = run([ev(0, "SessionStart"), ev(300, "SessionEnd", { reason: "other" })]);
  assert.equal(view(ended, T0 + 301e3).rows.length, 0, "an empty session that ends never shows");
});
