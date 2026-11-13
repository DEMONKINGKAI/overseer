// Overseer widget. Polls events from the Rust shell, runs them through core/state.js, renders.
// Interactive bits (Allow/Deny, answers, follow-ups) go back through Tauri commands.
const { initialState, reduce, tick, view, transcriptWatchList, STATUS } = window.OverseerState;
const { findToolResult, toEvent } = window.OverseerTranscript;
const { sentinel } = window.Sentinel;
const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const win = tauri?.window?.getCurrentWindow?.();
const LogicalSize = tauri?.dpi?.LogicalSize;

// ---------- state ----------
let state = initialState();
let cursor = 0;
let lastView = { rows: [], tray: "calm", badge: null };
let lastTray = "";
let prevStatus = {}, workingSince = {}, seenAsks = new Set();
const ui = { selected: null, mode: null, collapsed: false, prevHeight: 640, pinned: false, sound: true, dismissed: {} };
try { ui.sound = localStorage.getItem("sound") !== "0"; } catch {}

const $ = (id) => document.getElementById(id);
const main = $("main");

// ---------- icons ----------
const svg = (p, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
const I = {
  sound: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  mute: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>'),
  pin: svg('<path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4H6l4-4z"/>'),
  up: svg('<path d="m6 15 6-6 6 6"/>'), down: svg('<path d="m6 9 6 6 6-6"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'), back: svg('<path d="m15 18-6-6 6-6"/>'),
  open: svg('<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M10 14 16 8M11 8h5v5"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>', 'stroke-width="3"'), cross: svg('<path d="M18 6 6 18M6 6l12 12"/>', 'stroke-width="3"'),
  terminal: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), read: svg('<path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'), web: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  agent: svg('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/><path d="M3 19a6 6 0 0 1 12 0M14.5 19a4.5 4.5 0 0 1 7-3.7"/>'),
  question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>'),
  tool: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
};

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const shortModel = (m) => (m || "").replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");
function taskTitle(r) {
  const p = (r.lastPrompt || "").split(/\r?\n/)[0].replace(/^\s*(please|can you|could you)\s+/i, "").trim();
  if (!p || p.startsWith("<")) return "";
  return p.length > 42 ? p.slice(0, 40).trimEnd() + "…" : p;
}
function patch(el, html) { if (el._h !== html) { el.innerHTML = html; el._h = html; } }
function child(parent, cls, tag = "div") {
  let el = parent.querySelector(`:scope > .${cls.split(" ")[0]}`);
  if (!el) { el = document.createElement(tag); el.className = cls; parent.appendChild(el); }
  return el;
}
function keyed(el, key, html) { if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = html; } }
function toast(text) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2600);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(`Copied: ${text}`); } catch { toast(text); }
}

// ---------- data ----------
let pollFailures = 0;
async function poll() {
  try {
    const [events, next] = await invoke("events_since", { cursor });
    cursor = next;
    for (const e of events) state = reduce(state, e);
    pollFailures = 0;
  } catch (err) { pollFailures++; console.error("poll failed", err); }
}
async function checkTranscripts() {
  for (const w of transcriptWatchList(state)) {
    try {
      const tail = await invoke("read_transcript_tail", { path: w.transcriptPath, maxBytes: 262144 });
      const found = findToolResult(tail, w.toolUseId);
      if (found) state = reduce(state, toEvent(w.sessionId, found));
    } catch (err) { console.warn("transcript check failed", err); }
  }
}

// ---------- sound + notifications ----------
let audio;
function chime() {
  if (!ui.sound) return;
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime;
    [[880, 0], [1318.5, 0.11]].forEach(([f, d]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.12, t + d + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.35);
      o.connect(g).connect(audio.destination); o.start(t + d); o.stop(t + d + 0.4);
    });
  } catch {}
}
async function notify(title, body) {
  try {
    const n = tauri?.notification;
    if (n) {
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) return n.sendNotification({ title, body });
    }
    await invoke("plugin:notification|notify", { options: { title, body } });
  } catch (err) { console.warn("notification failed", err); }
}
function onTransitions(rows, now) {
  for (const r of rows) {
    const before = prevStatus[r.id];
    if (r.status === STATUS.WORKING && before !== STATUS.WORKING) workingSince[r.id] = now;
    if (r.ask && !seenAsks.has(r.ask.requestId)) {
      seenAsks.add(r.ask.requestId);
      chime();
      notify(r.ask.kind === "question" ? `${r.project} asks a question` : `${r.project} needs permission`,
        r.ask.kind === "question" ? (r.ask.questions?.[0]?.question || "") : askCode(r.ask));
    } else if (before && before !== r.status) {
      if (r.status === STATUS.PERMISSION && !r.ask) { chime(); notify(`${r.project} needs permission`, r.activity.replace(/^Needs approval[^:]*: /, "")); }
      else if (r.status === STATUS.YOUR_MOVE && before === STATUS.WORKING && now - (workingSince[r.id] || now) > 20e3) {
        notify(`${r.project} is done`, (r.lastMessage || "Your move").slice(0, 140));
      }
    }
    prevStatus[r.id] = r.status;
  }
}

// ---------- pieces ----------
function subLine(r) {
  if (r.status === "permission") return `<div class="sub attn">needs permission${r.ask ? "" : " · in terminal"}</div>`;
  if (r.status === "question") return `<div class="sub attn">asks a question${r.ask ? "" : " · in terminal"}</div>`;
  const cls = r.status === "your_move" ? "move" : r.status === "stale" ? "stale" : "";
  return `<div class="sub ${cls}">${esc(r.activity)}</div>`;
}
function progressHtml(r) {
  if (r.progress) {
    const pct = r.progress.total ? Math.round((r.progress.done / r.progress.total) * 100) : 0;
    return `<div class="prog"><div class="prog-label"><b>${r.progress.done}/${r.progress.total}</b> ${esc(r.progress.label)}</div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }
  const bits = [dur(r.elapsedMs)];
  if (r.model) bits.push(`<span class="pill">${esc(shortModel(r.model))}</span>`);
  const running = r.agents.filter((a) => a.status === "running").length;
  if (running) bits.push(`${running} agent${running > 1 ? "s" : ""}`);
  if (r.queued) bits.push(`<span class="pill">follow-up queued</span>`);
  return `<div class="meta">${bits.map((b) => `<span>${b}</span>`).join("")}</div>`;
}
function titleHtml(r) {
  const task = taskTitle(r);
  return `<div class="title">${esc(r.project)}${task ? `<span class="task"> · ${esc(task)}</span>` : ""}</div>`;
}
function askCode(a) {
  const i = a.input || {};
  const arg = i.command || i.file_path || i.url || i.pattern || i.query || (Object.keys(i).length ? JSON.stringify(i) : "");
  return `${a.toolName}: ${arg}`.slice(0, 600);
}
function askHtml(r) {
  const a = r.ask;
  if (a && a.kind === "permission") return `
    <div class="ask" data-req="${esc(a.requestId)}" data-sid="${esc(r.id)}">
      <div class="code">${esc(askCode(a))}</div>
      <div class="btns main-btns">
        <button class="btn primary" data-act="allow">Allow</button>
        <button class="btn" data-act="deny-open">Deny</button>
        <button class="btn ghost" data-act="terminal">Answer in terminal</button>
      </div>
      <div class="deny-box" hidden>
        <input class="deny-reason" placeholder="Tell Claude why, or what to do instead (optional)" />
        <div class="btns"><button class="btn primary" data-act="deny">Deny</button><button class="btn ghost" data-act="deny-cancel">Cancel</button></div>
      </div>
    </div>`;
  if (a && a.kind === "question") return `
    <div class="ask" data-req="${esc(a.requestId)}" data-sid="${esc(r.id)}">
      ${(a.questions || []).map((q, qi) => `
        <div class="q" data-q="${qi}">
          ${q.header ? `<span class="chip">${esc(q.header)}</span>` : ""}
          <div class="q-text">${esc(q.question)}</div>
          ${(q.options || []).map((o) => `
            <label class="opt"><input type="${q.multiSelect ? "checkbox" : "radio"}" name="${esc(a.requestId)}-${qi}" value="${esc(o.label)}" />
              <span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ""}</span></label>`).join("")}
          <input class="free" placeholder="Or type your own answer…" />
        </div>`).join("")}
      <div class="btns"><button class="btn primary" data-act="send-q">Send</button><button class="btn ghost" data-act="terminal">Answer in terminal</button></div>
    </div>`;
  if (r.askReleased || r.status === "permission" || r.status === "question")
    return `<div class="note attn">Waiting for your answer in the terminal.</div>`;
  return "";
}
const askKey = (r) => (r.ask ? r.ask.requestId : r.askReleased || r.status === "permission" || r.status === "question" ? "terminal" : "");

// ---------- list view ----------
function renderList(v) {
  if (ui.mode !== "list") { main.innerHTML = ""; ui.mode = "list"; }
  const rows = v.rows.filter((r) => ui.dismissed[r.id] !== r.status);
  let empty = main.querySelector(":scope > .empty");
  if (!rows.length) {
    main.querySelectorAll(":scope > .card").forEach((c) => c.remove());
    if (!empty) { empty = document.createElement("div"); empty.className = "empty"; main.appendChild(empty); }
    patch(empty, v.rows.length ? "All caught up." : `No Claude Code sessions yet.<br><br>Start one, or install the hooks:<br><code>node hooks/install.js</code>`);
    return;
  }
  empty?.remove();
  const ids = new Set(rows.map((r) => r.id));
  main.querySelectorAll(":scope > .card").forEach((c) => { if (!ids.has(c.dataset.id)) c.remove(); });
  rows.forEach((r, i) => {
    let card = main.querySelector(`:scope > .card[data-id="${CSS.escape(r.id)}"]`);
    if (!card) { card = document.createElement("div"); card.className = "card"; card.dataset.id = r.id; }
    if (main.children[i] !== card) main.insertBefore(card, main.children[i] || null);
    card.className = `card ${r.status}${r.status === "permission" || r.status === "question" ? " attn" : ""}`;
    patch(child(card, "card-main"), `
      <div class="avatar" data-act="open">${sentinel(r.id, r.status, 52)}</div>
      <div data-act="open">${titleHtml(r)}${subLine(r)}${progressHtml(r)}</div>
      <div class="side"><button class="icon-btn" data-act="open" title="Details">${I.open}</button>
        <button class="icon-btn" data-act="dismiss" title="Hide until something changes">${I.x}</button></div>`);
    keyed(child(card, "ask-slot"), askKey(r), askHtml(r));
  });
}

// ---------- detail view ----------
function stepIcon(status) {
  if (status === "done" || status === "completed") return I.check;
  if (status === "denied" || status === "interrupted") return I.cross;
  return "";
}
function renderDetail(r) {
  if (ui.mode !== "detail:" + r.id) { main.innerHTML = '<div class="detail"></div>'; ui.mode = "detail:" + r.id; }
  const d = main.firstElementChild;
  patch(child(d, "hero"), `<div class="avatar">${sentinel(r.id, r.status, 76)}</div><div>${titleHtml(r)}${subLine(r)}${progressHtml(r)}</div>`);
  keyed(child(d, "ask-slot"), askKey(r), askHtml(r));

  patch(child(d, "plan section"), r.todos.length ? `<h4>Plan</h4><ul class="steps plan-list">${r.todos.map((t) => `
      <li class="${t.status}"><span class="st">${stepIcon(t.status)}</span><span class="txt">${esc(t.status === "in_progress" ? t.active || t.title : t.title)}</span></li>`).join("")}</ul>` : "");
  patch(child(d, "timeline section"), r.timeline.length ? `<h4>Activity</h4><ul class="steps">${r.timeline.map((s) => `
      <li class="${s.status}"><span class="st">${stepIcon(s.status)}</span><span class="k">${I[s.kind] || I.tool}</span><span class="txt" title="${esc(s.summary)}">${esc(s.summary)}</span></li>`).join("")}</ul>` : "");
  const t = r.terminal;
  patch(child(d, "terminal section"), t ? `<div class="term"><div class="term-chip">${I.terminal.replace("<svg", '<svg width="13" height="13"')} Terminal${t.running ? " · running" : ""}</div>
      <div class="cmd">$ ${esc(t.command)}</div>${t.output || t.running ? `<pre>${esc(t.output)}${t.running ? '<span class="cursor"></span>' : ""}</pre>` : ""}</div>` : "");
  patch(child(d, "agents section"), r.agents.length ? `<h4>Subagents</h4><ul class="steps agents">${r.agents.map((a) => `
      <li class="${a.status}"><span class="ad"></span><span class="txt"><b>${esc(a.type || "agent")}</b> · ${esc(a.activity || (a.status === "done" ? "finished" : "starting"))}</span></li>`).join("")}</ul>` : "");
  patch(child(d, "msg section"), r.lastMessage && (r.status === "your_move" || r.status === "ended") ? `<h4>Claude said</h4><div class="message">${esc(r.lastMessage)}</div>` : "");

  // follow-up: only deliverable at the end of a turn (Stop hook), so only while Claude is mid-turn
  const live = ["working", "permission", "question", "stale"].includes(r.status);
  const fu = child(d, "followup section");
  patch(child(fu, "queued-slot"), r.queued ? `<div class="queued"><span>Queued: ${esc(r.queued)}</span><button class="btn ghost" data-act="unqueue" data-sid="${esc(r.id)}">Cancel</button></div>` : "");
  keyed(child(fu, "composer-slot"), `${r.id}:${live ? "live" : r.status}`, live
    ? `<h4>Follow-up</h4><div class="composer"><textarea rows="1" data-sid="${esc(r.id)}" placeholder="Next instruction for Claude…"></textarea><button class="btn primary" data-act="queue" data-sid="${esc(r.id)}">Queue</button></div><div class="hint">Handed to Claude the moment this turn ends.</div>`
    : r.status === "your_move" ? `<div class="note">This session is idle at its prompt. Overseer can only hand Claude a message at the end of a turn, so reply in its terminal.</div>` : "");
  patch(child(d, "foot"), `<span>${esc(r.id.slice(0, 8))}</span>${r.model ? `<span>· ${esc(shortModel(r.model))}</span>` : ""}${r.permissionMode ? `<span>· ${esc(r.permissionMode)}</span>` : ""}<span>· ${dur(r.elapsedMs)}</span>
      <button class="btn" data-act="copy" data-text="${esc(r.resumeCommand)}">Copy resume command</button>`);
}

// ---------- header ----------
function renderHeader(v) {
  const left = $("head-left");
  const sel = ui.selected && v.rows.find((r) => r.id === ui.selected);
  if (sel) {
    patch(left, `<button class="icon-btn back" data-act="back" title="Back">${I.back}</button><div class="mini-strip">${v.rows.map((r) =>
      `<button class="mini${r.id === sel.id ? " sel" : ""}" data-act="select" data-sid="${esc(r.id)}" title="${esc(r.project)}">${sentinel(r.id, r.status, 26)}</button>`).join("")}</div>`);
  } else {
    const live = v.rows.filter((r) => r.status !== "ended").length;
    patch(left, `<span class="brand-dot ${v.tray}"></span><span class="brand">Overseer</span>${live ? `<span class="count">${live}</span>` : ""}`);
  }
  patch($("btn-sound"), ui.sound ? I.sound : I.mute);
  patch($("btn-pin"), I.pin); $("btn-pin").classList.toggle("on", ui.pinned);
  patch($("btn-collapse"), ui.collapsed ? I.down : I.up);
  patch($("btn-close"), I.x);
}

function render(v) {
  renderHeader(v);
  if (ui.collapsed) return;
  const sel = ui.selected && v.rows.find((r) => r.id === ui.selected);
  if (!sel) ui.selected = null;
  sel ? renderDetail(sel) : renderList(v);
}

async function updateTray(v) {
  const key = `${v.tray}|${v.badge ?? ""}`;
  if (key === lastTray) return;
  lastTray = key;
  const text = { amber: "waiting for you", blue: "your move", warn: "possibly stuck", active: "all working", calm: "nothing running" }[v.tray];
  try { await invoke("set_tray", { state: v.tray, tooltip: v.badge ? `Overseer: ${v.badge} ${text}` : `Overseer: ${text}` }); } catch {}
}

// ---------- actions ----------
async function answer(box, reply) {
  box.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
  try {
    const ok = await invoke("answer_ask", { requestId: box.dataset.req, reply });
    if (!ok) toast("That prompt was already answered or timed out.");
  } catch (err) { toast("Couldn't send: " + err); box.querySelectorAll("button, input").forEach((b) => (b.disabled = false)); }
}
function collectAnswers(box) {
  const answers = {};
  const r = lastView.rows.find((x) => x.ask && x.ask.requestId === box.dataset.req);
  const qs = r?.ask?.questions || [];
  for (const qEl of box.querySelectorAll(".q")) {
    const q = qs[Number(qEl.dataset.q)];
    if (!q) continue;
    const free = qEl.querySelector(".free").value.trim();
    const picked = [...qEl.querySelectorAll("input:checked")].map((i) => i.value);
    const value = free || picked.join(", ");
    if (!value) return null;
    answers[q.question] = value;
  }
  return answers;
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const box = el.closest(".ask");
  const card = el.closest(".card");
  switch (act) {
    case "open": if (card) { ui.selected = card.dataset.id; render(lastView); } break;
    case "select": ui.selected = el.dataset.sid; render(lastView); break;
    case "back": ui.selected = null; render(lastView); break;
    case "dismiss": { const r = lastView.rows.find((x) => x.id === card.dataset.id); if (r) ui.dismissed[r.id] = r.status; render(lastView); break; }
    case "allow": answer(box, { outcome: "allow" }); break;
    case "deny-open": box.querySelector(".deny-box").hidden = false; box.querySelector(".main-btns").hidden = true; box.querySelector(".deny-reason").focus(); break;
    case "deny-cancel": box.querySelector(".deny-box").hidden = true; box.querySelector(".main-btns").hidden = false; break;
    case "deny": answer(box, { outcome: "deny", message: box.querySelector(".deny-reason").value.trim() || undefined }); break;
    case "terminal": answer(box, { outcome: "terminal" }); break;
    case "send-q": { const a = collectAnswers(box); if (!a) return toast("Pick or type an answer for each question."); answer(box, { outcome: "answered", answers: a }); break; }
    case "queue": {
      const ta = el.parentElement.querySelector("textarea"); const message = ta.value.trim();
      if (!message) return ta.focus();
      try { await invoke("queue_followup", { sessionId: el.dataset.sid, message }); ta.value = ""; toast("Queued: Claude gets it when this turn ends."); } catch (err) { toast("Couldn't queue: " + err); }
      break;
    }
    case "unqueue": try { await invoke("cancel_followup", { sessionId: el.dataset.sid }); } catch {} break;
    case "copy": copy(el.dataset.text); break;
  }
});
document.addEventListener("change", (e) => {
  const opt = e.target.closest(".opt");
  if (!opt) return;
  const q = opt.closest(".q");
  q.querySelectorAll(".opt").forEach((o) => o.classList.toggle("sel", o.querySelector("input").checked));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.selected) { ui.selected = null; render(lastView); }
  if (e.key === "Enter" && !e.shiftKey && e.target.matches(".composer textarea")) { e.preventDefault(); e.target.parentElement.querySelector("[data-act=queue]").click(); }
  if (e.key === "Enter" && e.target.matches(".deny-reason")) e.target.closest(".ask").querySelector("[data-act=deny]").click();
});
document.addEventListener("input", (e) => {
  if (e.target.matches(".composer textarea")) { e.target.style.height = "auto"; e.target.style.height = Math.min(110, e.target.scrollHeight) + "px"; }
});

$("btn-sound").onclick = () => { ui.sound = !ui.sound; try { localStorage.setItem("sound", ui.sound ? "1" : "0"); } catch {} if (ui.sound) chime(); renderHeader(lastView); };
$("btn-pin").onclick = async () => { ui.pinned = !ui.pinned; try { await win?.setAlwaysOnTop(ui.pinned); } catch {} renderHeader(lastView); };
$("btn-close").onclick = () => win?.hide();
$("btn-collapse").onclick = async () => {
  ui.collapsed = !ui.collapsed;
  $("panel").classList.toggle("collapsed", ui.collapsed);
  main.style.display = ui.collapsed ? "none" : "";
  // the window's minimum height (4 sessions) would block collapsing, so lift it while collapsed
  const MIN = { w: 400, h: 520 };
  try {
    if (ui.collapsed) {
      ui.prevHeight = window.innerHeight;
      await win?.setMinSize(new LogicalSize(MIN.w, 66));
      await win?.setSize(new LogicalSize(window.innerWidth, 66));
    } else {
      await win?.setSize(new LogicalSize(window.innerWidth, Math.max(MIN.h, ui.prevHeight)));
      await win?.setMinSize(new LogicalSize(MIN.w, MIN.h));
    }
  } catch (err) { console.warn(err); }
  render(lastView);
};

// ---------- loop ----------
let tickCount = 0;
async function loop() {
  await poll();
  if (tickCount++ % 4 === 0) await checkTranscripts();
  const now = Date.now();
  state = tick(state, now);
  lastView = view(state, now);
  onTransitions(lastView.rows, now);
  render(lastView);
  updateTray(lastView);
  setTimeout(loop, 500);
}

if (!invoke) main.innerHTML = `<div class="empty">Open this inside the Overseer app (npm run dev).</div>`;
else loop();
