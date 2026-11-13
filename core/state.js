// Overseer core: turns Claude Code hook events into live session state.
// Pure and dependency-free: runs in Node (tests) and in the widget's webview unchanged.
//
//   let s = initialState();
//   s = reduce(s, event);        // every hook event + synthetic app events
//   s = tick(s, Date.now());     // every few seconds: stale detection, cleanup
//   view(s, Date.now())          // what the widget renders
//
// Synthetic events (made by the app, not Claude Code):
//   AskOpened / AskResolved      a hook is holding a permission prompt or question open for the widget
//   FollowupQueued / FollowupCancelled   a message waiting to be handed to Claude when its turn ends
//   ToolResolved                 transcript shows a tool result the hooks never reported (denials)

const STATUS = {
  PERMISSION: "permission", // 🟠 blocked on an approval prompt
  QUESTION: "question",     // 🟠 Claude asked a question (AskUserQuestion)
  YOUR_MOVE: "your_move",   // 🔵 turn finished / waiting for input, nothing running
  STALE: "stale",           // ⚠️ "working" but silent too long
  WORKING: "working",       // 🟢 tools running, thinking, or background agents busy
  ENDED: "ended",           // ⚫ session closed
};
const PRIORITY = { permission: 0, question: 0, your_move: 1, stale: 2, working: 3, ended: 4 };

const DEFAULTS = {
  staleToolMs: { Bash: 10 * 60e3, PowerShell: 10 * 60e3, Agent: 30 * 60e3, Task: 30 * 60e3, AskUserQuestion: 24 * 3600e3, default: 3 * 60e3 },
  staleIdleMs: 4 * 60e3,
  ephemeralMs: 15e3,
  endedRetentionMs: 10 * 60e3,
  timelineMax: 30,
};

const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

const initialState = () => ({ sessions: {} });
const ts = (e) => (typeof e.ts === "number" ? e.ts : e.ts ? Date.parse(e.ts) : Date.now());
const basename = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || "?";

function toolKind(name) {
  if (SHELL_TOOLS.has(name)) return "terminal";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "edit";
  if (name === "Read") return "read";
  if (/^(Glob|Grep|LS)$/.test(name)) return "search";
  if (/^Web/.test(name)) return "web";
  if (/^(Agent|Task)$/.test(name)) return "agent";
  if (name === "AskUserQuestion") return "question";
  if (/^mcp__/.test(name)) return "tool";
  return "tool";
}

function toolSummary(name, input = {}) {
  const verb = { Read: "Reading", Edit: "Editing", Write: "Writing", MultiEdit: "Editing", NotebookEdit: "Editing", Bash: "Running", PowerShell: "Running",
                 Glob: "Searching", Grep: "Searching", WebFetch: "Fetching", WebSearch: "Searching web", Agent: "Delegating", Task: "Delegating",
                 AskUserQuestion: "Asking", SubagentHandback: "Reporting back" }[name] || name.replace(/^mcp__[^_]+__/, "");
  if (name === "SubagentHandback") return verb;
  if (name === "AskUserQuestion") return `Asking: ${input.questions?.[0]?.question || "a question"}`.slice(0, 100);
  const arg = input.file_path ? basename(input.file_path)
    : input.command || input.pattern || input.description || input.url || input.query || input.prompt || "";
  const short = String(arg).replace(/\s+/g, " ");
  return `${verb}${short ? " " + short.slice(0, 90) : ""}`;
}

// Bash/PowerShell output → last lines of text
function shellOutput(resp) {
  if (resp == null) return "";
  let text = typeof resp === "string" ? resp
    : [resp.stdout, resp.stderr, resp.output, resp.content].filter((x) => typeof x === "string" && x).join("\n");
  if (!text && typeof resp === "object") text = JSON.stringify(resp);
  return text.split(/\r?\n/).slice(-14).join("\n").slice(-1800);
}

function newSession(e, t) {
  return {
    id: e.session_id, cwd: e.cwd || null, project: basename(e.cwd), model: e.model || null,
    permissionMode: e.permission_mode || null, transcriptPath: e.transcript_path || null,
    status: STATUS.YOUR_MOVE, startedAt: t, lastEventAt: t, endedAt: null, endReason: null,
    activity: "Started", lastMessage: null, lastPrompt: null,
    openTools: {}, agents: {}, backgroundTasks: 0, turnEnded: false, compacting: false,
    pendingPermission: null, pendingToolUseId: null,
    ask: null,            // { requestId, kind: "permission"|"question", toolName, summary, input, questions, released }
    todos: [],            // [{ id, title, active, status: pending|in_progress|completed }]
    pendingCreates: {},   // tool_use_id → { title, active } (TaskCreate before its id is known)
    timeline: [],         // [{ id, kind, summary, status: running|done|denied|interrupted, startedAt, endedAt }]
    terminal: null,       // { command, output, running, toolUseId, endedAt }
    queued: null,         // follow-up message waiting for the end of the turn
    engaged: false,       // anything real happened (prompt, tool, prompt for approval…); until then the card stays hidden
  };
}

function agentFor(s, e, t) {
  if (!e.agent_id) return null;
  return (s.agents[e.agent_id] ||= { type: e.agent_type || "", status: "running", activity: "", startedAt: t, lastEventAt: t, toolCount: 0 });
}
const runningAgents = (s) => Object.values(s.agents).filter((a) => a.status === "running").length;
function closeAgents(s, t) {
  for (const [id, a] of Object.entries(s.agents)) if (a.status === "running") { a.status = "done"; a.endedAt = t; }
  for (const [id, tool] of Object.entries(s.openTools)) if (tool.agentId) delete s.openTools[id];
}
function doneLabel(s) {
  const n = Math.max(runningAgents(s), s.backgroundTasks);
  return n ? `Your move · ${n} background task${n > 1 ? "s" : ""} running` : "Done — your move";
}
const AGENT_SILENT_MS = 10 * 60e3; // a subagent with no events this long is treated as finished

function settle(s) {
  if (s.endedAt) return STATUS.ENDED;
  if (s.ask && s.ask.kind === "question") return STATUS.QUESTION;
  if (s.ask || s.pendingPermission) return STATUS.PERMISSION;
  // Once Claude's turn has ended the user can type, so it's their move even if subagents or
  // background tasks are still running (the activity line says so).
  const mainBusy = Object.values(s.openTools).some((x) => !x.agentId) || s.compacting;
  if (s.turnEnded && !mainBusy) return STATUS.YOUR_MOVE;
  return STATUS.WORKING;
}

function clearAsk(s) { s.ask = null; s.pendingPermission = null; s.pendingToolUseId = null; }

function setStep(s, id, status, t) {
  const step = s.timeline.find((x) => x.id === id);
  if (step && step.status === "running") { step.status = status; step.endedAt = t; }
}

// ----- plan (TodoWrite / TaskCreate / TaskUpdate) -----
function applyPlanPre(s, e) {
  const input = e.tool_input || {};
  if (e.tool_name === "TodoWrite" && Array.isArray(input.todos)) {
    s.todos = input.todos.map((x, i) => ({ id: String(x.id ?? i + 1), title: x.content || x.subject || "", active: x.activeForm || x.content || "", status: x.status || "pending" }));
  } else if (e.tool_name === "TaskCreate") {
    s.pendingCreates[e.tool_use_id || "_"] = { title: input.subject || input.description || "Task", active: input.activeForm || input.subject || "" };
  } else if (e.tool_name === "TaskUpdate" && input.taskId != null) {
    const id = String(input.taskId);
    const todo = s.todos.find((x) => x.id === id);
    if (input.status === "deleted") s.todos = s.todos.filter((x) => x.id !== id);
    else if (todo) {
      if (input.status) todo.status = input.status;
      if (input.subject) todo.title = input.subject;
      if (input.activeForm) todo.active = input.activeForm;
    }
  }
}
function applyPlanPost(s, e) {
  if (e.tool_name !== "TaskCreate") return;
  const key = e.tool_use_id || "_";
  const pending = s.pendingCreates[key];
  if (!pending) return;
  delete s.pendingCreates[key];
  const text = typeof e.tool_response === "string" ? e.tool_response : JSON.stringify(e.tool_response || "");
  const m = text.match(/#(\d+)/) || text.match(/"id"\s*:\s*"?(\d+)/);
  const nextNum = Math.max(0, ...s.todos.map((x) => Number(x.id) || 0)) + 1;
  s.todos.push({ id: m ? m[1] : String(nextNum), title: pending.title, active: pending.active, status: "pending" });
}

function reduce(state, e) {
  if (!e || !e.session_id) return state;
  const t = ts(e);
  const ev = e.hook_event_name || e.argv_event;
  const sessions = { ...state.sessions };
  const prev = sessions[e.session_id];
  const s = prev ? structuredClone(prev) : newSession(e, t);
  sessions[e.session_id] = s;
  const done = () => ({ ...state, sessions });

  s.lastEventAt = Math.max(s.lastEventAt, t);
  if (e.cwd && (!s.cwd || s.project === "?")) { s.cwd = e.cwd; s.project = basename(e.cwd); }
  if (e.model) s.model = e.model;
  if (e.permission_mode) s.permissionMode = e.permission_mode;
  if (e.transcript_path && !e.agent_id) s.transcriptPath = e.transcript_path;
  if (s.status === STATUS.STALE) s.status = STATUS.WORKING;
  const agent = agentFor(s, e, t);
  if (agent) agent.lastEventAt = t;
  // Opening, resuming or idle-pinging a session isn't activity: the desktop app's Code tab resumes old
  // sessions in the background, and those shouldn't get a card until something actually happens.
  const passive = ev === "SessionStart" || ev === "SessionEnd" || ev === "PreCompact"
    || (ev === "Notification" && e.notification_type === "idle_prompt");
  if (!passive) s.engaged = true;

  switch (ev) {
    case "SessionStart":
      s.endedAt = null; s.endReason = null; s.turnEnded = true; s.compacting = false;
      s.activity = e.source && e.source !== "startup" ? `Session ${e.source}` : "Started";
      break;

    case "UserPromptSubmit": {
      const handback = /^\s*<agent-message/.test(e.prompt || "");
      if (!handback && !agent) {
        for (const [id, tool] of Object.entries(s.openTools)) if (!tool.agentId) { delete s.openTools[id]; setStep(s, id, "interrupted", t); }
        s.lastPrompt = (e.prompt || "").slice(0, 300);
        clearAsk(s);
      }
      s.turnEnded = false;
      s.activity = handback ? "Reading subagent results" : "Thinking";
      break;
    }

    case "PreToolUse": {
      const summary = toolSummary(e.tool_name, e.tool_input);
      const id = e.tool_use_id || `${e.tool_name}@${t}`;
      s.openTools[id] = { name: e.tool_name, summary, startedAt: t, agentId: e.agent_id || null };
      if (PLAN_TOOLS.has(e.tool_name)) { if (!agent) applyPlanPre(s, e); break; }
      if (agent) { agent.activity = summary; agent.toolCount++; break; }
      s.activity = summary; s.turnEnded = false;
      s.timeline.push({ id, kind: toolKind(e.tool_name), summary, status: "running", startedAt: t, endedAt: null });
      if (s.timeline.length > DEFAULTS.timelineMax) s.timeline.splice(0, s.timeline.length - DEFAULTS.timelineMax);
      if (SHELL_TOOLS.has(e.tool_name)) s.terminal = { command: String(e.tool_input?.command || ""), output: "", running: true, toolUseId: id, endedAt: null };
      break;
    }

    case "PostToolUse": {
      const id = e.tool_use_id || Object.keys(s.openTools).find((k) => s.openTools[k].name === e.tool_name);
      if (id) delete s.openTools[id];
      if (PLAN_TOOLS.has(e.tool_name)) { if (!agent) applyPlanPost(s, e); break; }
      if (!agent) {
        setStep(s, id, "done", t);
        if (s.terminal && s.terminal.toolUseId === id) Object.assign(s.terminal, { output: shellOutput(e.tool_response), running: false, endedAt: t });
        if (s.ask && (!s.ask.toolUseId || s.ask.toolUseId === id || s.ask.toolName === e.tool_name)) clearAsk(s);
        if (s.pendingPermission) { s.pendingPermission = null; s.pendingToolUseId = null; }
        if (/^Needs approval|^Asking|^Approved|^Answered/.test(s.activity)) s.activity = "Thinking";
      }
      break;
    }

    case "AskOpened": { // a hook is holding the prompt for the widget
      const input = e.tool_input || {};
      const kind = e.ask_kind === "question" ? "question" : "permission";
      s.ask = { requestId: e.request_id, kind, toolName: e.tool_name, toolUseId: e.tool_use_id || null,
                summary: toolSummary(e.tool_name, input), input, released: false,
                questions: kind === "question" ? (input.questions || []) : null, openedAt: t };
      s.activity = kind === "question" ? (input.questions?.[0]?.question || "Asks a question") : `Needs approval: ${s.ask.summary}`;
      s.turnEnded = false;
      break;
    }

    case "AskResolved": {
      if (!s.ask || s.ask.requestId !== e.request_id) break;
      const o = e.outcome;
      if (o === "allow" || o === "answered") { s.activity = o === "allow" ? "Approved" : "Answered"; clearAsk(s); }
      else if (o === "deny") { s.activity = "Denied — Claude is adjusting"; clearAsk(s); }
      else { // "terminal" / "timeout": the prompt now shows in the terminal; keep blocking state, drop widget controls
        s.ask.released = true;
        s.activity = s.ask.kind === "question" ? "Question — answer in terminal" : `Needs approval in terminal: ${s.ask.summary}`;
      }
      break;
    }

    case "Notification":
      if (e.notification_type === "permission_prompt" || /permission/i.test(e.message || "")) {
        if (!s.ask) {
          const [waitId, waiting] = Object.entries(s.openTools).filter(([, x]) => !x.agentId).sort((a, b) => b[1].startedAt - a[1].startedAt)[0] || [];
          s.pendingPermission = waiting ? waiting.summary : (e.message || "Permission needed");
          s.pendingToolUseId = waitId || null;
          s.activity = `Needs approval: ${s.pendingPermission}`;
        }
      } else if (e.notification_type === "idle_prompt") { s.turnEnded = true; s.activity = "Waiting for you"; }
      break;

    case "ToolResolved":
      if (e.tool_use_id) { delete s.openTools[e.tool_use_id]; setStep(s, e.tool_use_id, e.outcome === "rejected" ? "denied" : "done", t); }
      if (e.outcome === "rejected" && s.pendingToolUseId === e.tool_use_id) { clearAsk(s); s.turnEnded = true; s.activity = "Denied — your move"; }
      break;

    case "Stop":
      if (agent) break;
      for (const [id, tool] of Object.entries(s.openTools)) if (!tool.agentId) { delete s.openTools[id]; setStep(s, id, "interrupted", t); }
      clearAsk(s);
      if (e.last_assistant_message) s.lastMessage = e.last_assistant_message.slice(0, 400);
      s.backgroundTasks = Array.isArray(e.background_tasks) ? e.background_tasks.length : s.backgroundTasks;
      if (Array.isArray(e.background_tasks) && e.background_tasks.length === 0) closeAgents(s, t);
      if (e.followup_delivered) { // Overseer handed Claude the queued message: the turn continues
        s.queued = null; s.turnEnded = false; s.lastPrompt = String(e.followup_delivered).slice(0, 300);
        s.activity = `Following up: ${s.lastPrompt}`;
        break;
      }
      s.turnEnded = true;
      s.activity = doneLabel(s);
      break;

    case "SubagentStop":
      if (agent) {
        agent.status = "done";
        for (const [id, tool] of Object.entries(s.openTools)) if (tool.agentId === e.agent_id) delete s.openTools[id];
        if (s.backgroundTasks > 0 && agent.toolCount > 0) s.backgroundTasks--;
      }
      if (s.turnEnded) s.activity = doneLabel(s);
      break;

    case "FollowupQueued": s.queued = String(e.message || ""); break;
    case "FollowupCancelled": s.queued = null; break;

    case "PreCompact": s.compacting = true; s.activity = `Compacting (${e.trigger || "auto"})`; break;

    case "SessionEnd":
      s.endedAt = t; s.endReason = e.reason || null; s.openTools = {}; clearAsk(s); s.queued = null;
      for (const a of Object.values(s.agents)) a.status = "done";
      for (const step of s.timeline) if (step.status === "running") step.status = "interrupted";
      if (s.terminal) s.terminal.running = false;
      s.status = STATUS.ENDED; s.activity = "Ended";
      return done();
  }
  if (ev !== "PreCompact") s.compacting = false;
  s.status = settle(s);
  return done();
}

function tick(state, now, opts = DEFAULTS) {
  let changed = false;
  const sessions = {};
  for (const [id, s0] of Object.entries(state.sessions)) {
    if (s0.endedAt && now - s0.endedAt > opts.endedRetentionMs) { changed = true; continue; }
    let s = s0;
    const silentAgents = Object.values(s.agents).some((a) => a.status === "running" && now - a.lastEventAt > AGENT_SILENT_MS);
    if (silentAgents) {
      s = structuredClone(s);
      for (const a of Object.values(s.agents)) if (a.status === "running" && now - a.lastEventAt > AGENT_SILENT_MS) a.status = "done";
      for (const [tid, tool] of Object.entries(s.openTools)) if (tool.agentId && s.agents[tool.agentId]?.status === "done") delete s.openTools[tid];
      if (s.turnEnded) { s.backgroundTasks = Math.min(s.backgroundTasks, runningAgents(s)); s.activity = doneLabel(s); }
      changed = true;
    }
    if (s.status === STATUS.WORKING) {
      const tools = Object.values(s.openTools);
      const toolStale = tools.length > 0 && tools.every((tl) => now - tl.startedAt > (opts.staleToolMs[tl.name] ?? opts.staleToolMs.default));
      const silent = tools.length === 0 && runningAgents(s) === 0 && now - s.lastEventAt > opts.staleIdleMs;
      if (toolStale || silent) { s = { ...s, status: STATUS.STALE, activity: `No activity — ${s.activity}` }; changed = true; }
    }
    sessions[id] = s;
  }
  return changed ? { ...state, sessions } : state;
}

const isHidden = (s) => !s.engaged || (!!s.endedAt && s.endedAt - s.startedAt < DEFAULTS.ephemeralMs);
const visibleAgents = (s) => Object.entries(s.agents)
  .filter(([, a]) => a.type !== "" || a.toolCount > 0)
  .map(([id, a]) => ({ id, ...a }));

function progressOf(s) {
  if (!s.todos.length) return null;
  const done = s.todos.filter((x) => x.status === "completed").length;
  const cur = s.todos.find((x) => x.status === "in_progress");
  return { done, total: s.todos.length, label: cur ? (cur.active || cur.title) : done === s.todos.length ? "All done" : "Up next: " + (s.todos.find((x) => x.status === "pending")?.title || "") };
}

function view(state, now = Date.now()) {
  const rows = Object.values(state.sessions)
    .filter((s) => !isHidden(s))
    .map((s) => ({
      id: s.id, project: s.project, cwd: s.cwd, model: s.model, status: s.status,
      activity: s.activity, lastMessage: s.lastMessage, lastPrompt: s.lastPrompt,
      elapsedMs: (s.endedAt || now) - s.startedAt, idleMs: now - s.lastEventAt,
      agents: visibleAgents(s), resumeCommand: `claude --resume ${s.id}`,
      progress: progressOf(s), todos: s.todos, timeline: s.timeline.slice(-12), terminal: s.terminal,
      ask: s.ask && !s.ask.released ? s.ask : null, askReleased: !!(s.ask && s.ask.released),
      queued: s.queued, permissionMode: s.permissionMode,
    }))
    .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || a.idleMs - b.idleMs);
  const count = (st) => rows.filter((r) => r.status === st).length;
  const blocked = count(STATUS.PERMISSION) + count(STATUS.QUESTION);
  const tray = blocked ? "amber" : count(STATUS.YOUR_MOVE) ? "blue"
             : count(STATUS.STALE) ? "warn" : count(STATUS.WORKING) ? "active" : "calm";
  return { rows, tray, badge: blocked || null, needsYou: blocked + count(STATUS.YOUR_MOVE) };
}

const transcriptWatchList = (state) => Object.values(state.sessions)
  .filter((s) => s.status === STATUS.PERMISSION && !s.ask && s.pendingToolUseId && s.transcriptPath)
  .map((s) => ({ sessionId: s.id, transcriptPath: s.transcriptPath, toolUseId: s.pendingToolUseId }));

const stateApi = { transcriptWatchList, STATUS, PRIORITY, DEFAULTS, initialState, reduce, tick, view, toolSummary, toolKind };
if (typeof module !== "undefined" && module.exports) module.exports = stateApi;
else globalThis.OverseerState = stateApi;
