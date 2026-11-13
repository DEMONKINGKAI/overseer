// Shared by Overseer's hooks.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.OVERSEER_PORT) || 47321;
const SPOOL_DIR = path.join(os.homedir(), ".overseer");
const SPOOL = path.join(SPOOL_DIR, "spool.jsonl");
const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
const MAX_STR = 4000;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

function readStdin(cb) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => cb(raw));
  process.stdin.on("error", () => cb(raw));
}

function trim(v) {
  if (typeof v === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = trim(x); return o; }
  return v;
}
const tail = (s, n) => (typeof s === "string" && s.length > n ? s.slice(-n) : s);

// What Overseer keeps of an event: drop bulky tool output, except the tail of shell output
// (terminal panel) and TaskCreate's result (task ids).
function slim(payload) {
  const p = { ...payload };
  if ("tool_response" in p) {
    const r = p.tool_response;
    if (SHELL_TOOLS.has(p.tool_name)) {
      p.tool_response = typeof r === "string" ? tail(r, 3000)
        : r && typeof r === "object" ? { stdout: tail(r.stdout, 3000), stderr: tail(r.stderr, 1500), interrupted: r.interrupted } : r;
    } else if (p.tool_name === "TaskCreate") {
      p.tool_response = (typeof r === "string" ? r : JSON.stringify(r)).slice(0, 400);
    } else delete p.tool_response;
  }
  return trim(p);
}

function spool(line) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    let size = 0; try { size = fs.statSync(SPOOL).size; } catch {}
    if (size < SPOOL_MAX_BYTES) fs.appendFileSync(SPOOL, line + "\n");
  } catch {}
}

// HTTP to the app. cb(err, status, bodyText)
function request(method, urlPath, body, timeoutMs, cb) {
  let called = false;
  const once = (...a) => { if (!called) { called = true; cb(...a); } };
  const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, timeout: timeoutMs,
    headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
    (res) => { let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c)); res.on("end", () => once(null, res.statusCode, t)); });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => once(e));
  req.end(data || undefined);
}

// Send one event; spool it if the app isn't there.
function sendEvent(event, cb) {
  const line = JSON.stringify(event);
  request("POST", "/event", line, 800, (err) => { if (err) spool(line); cb && cb(); });
}

module.exports = { PORT, readStdin, slim, spool, request, sendEvent };
