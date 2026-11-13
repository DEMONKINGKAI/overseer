// Overseer — Rust shell.
// Thin by design: receives hook events on localhost, keeps an in-memory event log, holds
// interactive prompts (permission / question) open until the widget answers, queues follow-ups,
// owns the tray icon and reads transcripts. All state logic lives in core/state.js.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const PORT: u16 = 47321; // must match hooks/lib.js
const MAX_EVENTS: usize = 20_000;
const ASK_TIMEOUT: Duration = Duration::from_secs(120); // hook gives up at 125 s

#[derive(Default)]
struct EventLog {
    base: usize,
    events: Vec<Value>,
}

#[derive(Clone)]
struct Shared {
    log: Arc<Mutex<EventLog>>,
    asks: Arc<Mutex<HashMap<String, Sender<Value>>>>, // request_id → where the widget's answer goes
    followups: Arc<Mutex<HashMap<String, String>>>,   // session_id → queued message
}

static ASK_SEQ: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn push(log: &Arc<Mutex<EventLog>>, v: Value) {
    let mut l = log.lock().unwrap();
    l.events.push(v);
    if l.events.len() > MAX_EVENTS {
        let drop = l.events.len() - MAX_EVENTS;
        l.events.drain(0..drop);
        l.base += drop;
    }
}

fn overseer_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".overseer")
}

fn replay_spool(log: &Arc<Mutex<EventLog>>) {
    let spool = overseer_dir().join("spool.jsonl");
    if let Ok(text) = fs::read_to_string(&spool) {
        for line in text.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                push(log, v);
            }
        }
        let _ = fs::write(&spool, "");
    }
}

fn respond_json(req: tiny_http::Request, code: u16, body: &Value) {
    let header: tiny_http::Header = "Content-Type: application/json".parse().unwrap();
    let res = tiny_http::Response::from_string(body.to_string())
        .with_status_code(code)
        .with_header(header);
    let _ = req.respond(res);
}

fn read_body(req: &mut tiny_http::Request) -> String {
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    body
}

/// A hook is holding a prompt open: announce it, wait for the widget (or time out), reply to the hook.
fn handle_ask(mut req: tiny_http::Request, shared: Shared) {
    let body = read_body(&mut req);
    let mut event: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return respond_json(req, 400, &json!({ "error": "bad json" })),
    };
    let id = format!("ask-{}-{}", now_ms(), ASK_SEQ.fetch_add(1, Ordering::SeqCst));
    let session_id = event.get("session_id").cloned().unwrap_or(Value::Null);
    let (tx, rx) = mpsc::channel::<Value>();
    shared.asks.lock().unwrap().insert(id.clone(), tx);
    if let Some(o) = event.as_object_mut() {
        o.insert("hook_event_name".into(), json!("AskOpened"));
        o.insert("request_id".into(), json!(id));
    }
    push(&shared.log, event);

    let reply = rx.recv_timeout(ASK_TIMEOUT).unwrap_or_else(|_| json!({ "outcome": "timeout" }));
    shared.asks.lock().unwrap().remove(&id);
    let outcome = reply.get("outcome").cloned().unwrap_or(json!("timeout"));
    push(&shared.log, json!({ "ts": now_ms(), "session_id": session_id, "hook_event_name": "AskResolved",
                              "request_id": id, "outcome": outcome }));
    respond_json(req, 200, &reply);
}

fn handle_request(mut req: tiny_http::Request, shared: Shared) {
    let url = req.url().to_string();
    let is_post = *req.method() == tiny_http::Method::Post;
    if is_post && url == "/event" {
        let body = read_body(&mut req);
        if let Ok(v) = serde_json::from_str::<Value>(&body) {
            push(&shared.log, v);
        }
        let _ = req.respond(tiny_http::Response::empty(204));
    } else if is_post && url == "/ask" {
        handle_ask(req, shared);
    } else if url.starts_with("/followup") {
        let session = url.split("session=").nth(1).unwrap_or("").split('&').next().unwrap_or("").to_string();
        let session = percent_decode(&session);
        let msg = shared.followups.lock().unwrap().remove(&session);
        match msg {
            Some(m) => respond_json(req, 200, &json!({ "message": m })),
            None => {
                let _ = req.respond(tiny_http::Response::empty(204));
            }
        }
    } else if url == "/health" {
        let _ = req.respond(tiny_http::Response::from_string("overseer"));
    } else {
        let _ = req.respond(tiny_http::Response::empty(404));
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn start_server(shared: Shared) {
    thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("overseer: cannot listen on 127.0.0.1:{PORT} ({e}). Is Overseer already running?");
                return;
            }
        };
        for req in server.incoming_requests() {
            let shared = shared.clone();
            // one thread per request: /ask can wait for minutes and must not block other events
            thread::spawn(move || handle_request(req, shared));
        }
    });
}

// ---------- commands (called from the UI) ----------

#[tauri::command]
fn events_since(state: tauri::State<Shared>, cursor: usize) -> (Vec<Value>, usize) {
    let l = state.log.lock().unwrap();
    let start = if cursor < l.base { 0 } else { (cursor - l.base).min(l.events.len()) };
    (l.events[start..].to_vec(), l.base + l.events.len())
}

/// Widget answered a held prompt. reply: { outcome: allow|deny|answered|terminal, message?, answers? }
#[tauri::command]
fn answer_ask(state: tauri::State<Shared>, request_id: String, reply: Value) -> bool {
    let tx = state.asks.lock().unwrap().remove(&request_id);
    match tx {
        Some(tx) => tx.send(reply).is_ok(),
        None => false, // already answered or timed out
    }
}

#[tauri::command]
fn queue_followup(state: tauri::State<Shared>, session_id: String, message: String) {
    state.followups.lock().unwrap().insert(session_id.clone(), message.clone());
    push(&state.log, json!({ "ts": now_ms(), "session_id": session_id, "hook_event_name": "FollowupQueued", "message": message }));
}

#[tauri::command]
fn cancel_followup(state: tauri::State<Shared>, session_id: String) {
    state.followups.lock().unwrap().remove(&session_id);
    push(&state.log, json!({ "ts": now_ms(), "session_id": session_id, "hook_event_name": "FollowupCancelled" }));
}

/// Tail of a session transcript (denied prompts that weren't held by the widget). Only under ~/.claude/projects.
#[tauri::command]
fn read_transcript_tail(path: String, max_bytes: u64) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    let root = home.join(".claude").join("projects").canonicalize().map_err(|e| e.to_string())?;
    let file = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&root) {
        return Err("refusing to read outside ~/.claude/projects".into());
    }
    let mut f = fs::File::open(&file).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(max_bytes))).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn tray_icon_bytes(state: &str) -> &'static [u8] {
    match state {
        "amber" => &include_bytes!("../icons/tray-amber.png")[..],
        "blue" => &include_bytes!("../icons/tray-blue.png")[..],
        "warn" => &include_bytes!("../icons/tray-warn.png")[..],
        "active" => &include_bytes!("../icons/tray-active.png")[..],
        _ => &include_bytes!("../icons/tray-calm.png")[..],
    }
}

#[tauri::command]
fn set_tray(app: AppHandle, state: String, tooltip: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let icon = Image::from_bytes(tray_icon_bytes(&state)).map_err(|e| e.to_string())?;
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn toggle_window(app: &AppHandle, force_show: bool) {
    if let Some(w) = app.get_webview_window("main") {
        if !force_show && w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

#[tauri::command]
fn show_window(app: AppHandle) {
    toggle_window(&app, true);
}

fn main() {
    let shared = Shared {
        log: Arc::new(Mutex::new(EventLog::default())),
        asks: Arc::new(Mutex::new(HashMap::new())),
        followups: Arc::new(Mutex::new(HashMap::new())),
    };
    replay_spool(&shared.log);
    start_server(shared.clone());

    tauri::Builder::default()
        // must be first: a second launch just brings the running Overseer forward (and avoids a port clash)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| toggle_window(app, true)))
        // "Start with Windows" (tray menu). Launched at login with --hidden → straight to the tray.
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_notification::init())
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            events_since,
            answer_ask,
            queue_followup,
            cancel_followup,
            read_transcript_tail,
            set_tray,
            show_window
        ])
        .setup(|app| {
            // window starts hidden (tauri.conf.json); show it unless we were launched at login
            if !std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let show = MenuItem::with_id(app, "show", "Show Overseer", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart_on, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Overseer", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &autostart, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(tray_icon_bytes("calm"))?)
                .tooltip("Overseer")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_window(app, true),
                    "autostart" => {
                        // the check mark toggles itself on click; mirror that into the OS setting
                        let al = app.autolaunch();
                        let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_window(tray.app_handle(), false);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Overseer");
}
