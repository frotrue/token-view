mod db;
mod cloud;
mod export;
mod live;
mod pricing;
mod remote;
mod scan;
mod stats;
pub mod statusline;
mod tray;

use pricing::Pricing;
use scan::ScanStatus;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

struct AppState {
    db_path: PathBuf,
    status: Mutex<ScanStatus>,
    trigger: Mutex<Sender<()>>,
    /// Results of the last live refresh (limits APIs, status pages).
    live: Mutex<Value>,
    last_live: Mutex<i64>,
    cloud: cloud::CloudSync,
}

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

fn ui_settings(conn: &rusqlite::Connection) -> Value {
    db::get_setting(conn, "ui")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
fn get_dashboard(state: State<AppState>) -> Result<Value, String> {
    let conn = db::open(&state.db_path).map_err(err)?;
    stats::dashboard(&conn).map_err(err)
}

#[tauri::command]
fn get_status(state: State<AppState>) -> ScanStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn rescan(state: State<AppState>) {
    let _ = state.trigger.lock().unwrap().send(());
}

#[tauri::command]
fn rebuild(state: State<AppState>) -> Result<(), String> {
    let conn = db::open(&state.db_path).map_err(err)?;
    conn.execute_batch("DELETE FROM events; DELETE FROM files; DELETE FROM limits;")
        .map_err(err)?;
    let _ = state.trigger.lock().unwrap().send(());
    Ok(())
}

fn pricing_info(conn: &rusqlite::Connection) -> Value {
    let custom = db::get_setting(conn, "pricing").is_some();
    let default = remote::default_pricing(conn);
    json!({
        "pricing": scan::load_pricing(conn),
        "custom": custom,
        "defaultVersion": default.version,
        "builtinVersion": pricing::BUILTIN_VERSION,
        "remoteUrl": remote::PRICING_URL,
    })
}

#[tauri::command]
fn get_pricing(state: State<AppState>) -> Result<Value, String> {
    let conn = db::open(&state.db_path).map_err(err)?;
    Ok(pricing_info(&conn))
}

/// `None` drops the user's edits and goes back to the published default table.
#[tauri::command]
fn set_pricing(state: State<AppState>, pricing: Option<Pricing>) -> Result<Value, String> {
    let mut conn = db::open(&state.db_path).map_err(err)?;
    match &pricing {
        Some(p) => db::set_setting(&conn, "pricing", &serde_json::to_string(p).map_err(err)?).map_err(err)?,
        None => {
            conn.execute("DELETE FROM settings WHERE key='pricing'", []).map_err(err)?;
        }
    }
    let p = scan::load_pricing(&conn);
    scan::recompute_costs(&mut conn, &p).map_err(err)?;
    if pricing.is_none() {
        let _ = db::set_setting(&conn, "pricing_defaults_applied", &serde_json::to_string(&p).map_err(err)?);
    }
    Ok(pricing_info(&conn))
}

/// Pull the published price table now; the scan that follows re-prices if it changed.
#[tauri::command]
fn refresh_pricing(state: State<AppState>) -> Result<Value, String> {
    let conn = db::open(&state.db_path).map_err(err)?;
    remote::refresh(&conn, true)?;
    let _ = state.trigger.lock().unwrap().send(());
    Ok(pricing_info(&conn))
}

#[tauri::command]
fn statusline_status() -> Value {
    statusline::status()
}

#[tauri::command]
fn statusline_connect(connect: bool) -> Result<Value, String> {
    if connect {
        statusline::connect()
    } else {
        statusline::disconnect()
    }
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Value, String> {
    let conn = db::open(&state.db_path).map_err(err)?;
    Ok(ui_settings(&conn))
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: Value) -> Result<(), String> {
    let _settings_lock = state.cloud.settings_lock();
    let conn = db::open(&state.db_path).map_err(err)?;
    let previous = cloud::shared_settings(&ui_settings(&conn));
    db::set_setting(&conn, "ui", &settings.to_string()).map_err(err)?;
    if previous != cloud::shared_settings(&settings) {
        state.cloud.settings_changed(&settings)?;
    }
    Ok(())
}

#[tauri::command]
fn cloud_status(state: State<AppState>) -> cloud::DesktopCloudStatus {
    state.cloud.status()
}

#[tauri::command]
async fn cloud_configure(state: State<'_, AppState>, url: String, anon_key: String, device_name: String, enabled: bool) -> Result<cloud::DesktopCloudStatus, String> {
    let cloud = state.cloud.clone();
    tauri::async_runtime::spawn_blocking(move || cloud.configure(url, anon_key, device_name, enabled))
        .await.map_err(|_| "Cloud worker is unavailable".to_string())?
}

#[tauri::command]
async fn cloud_sign_in(state: State<'_, AppState>, email: String, password: String) -> Result<cloud::DesktopCloudStatus, String> {
    let cloud = state.cloud.clone();
    tauri::async_runtime::spawn_blocking(move || cloud.sign_in(email, password))
        .await.map_err(|_| "Cloud worker is unavailable".to_string())?
}

#[tauri::command]
async fn cloud_sign_out(state: State<'_, AppState>) -> Result<cloud::DesktopCloudStatus, String> {
    let cloud = state.cloud.clone();
    tauri::async_runtime::spawn_blocking(move || cloud.sign_out())
        .await.map_err(|_| "Cloud worker is unavailable".to_string())?
}

#[tauri::command]
fn cloud_sync_now(state: State<AppState>) -> Result<cloud::DesktopCloudStatus, String> {
    state.cloud.sync_now(&state.trigger.lock().unwrap())
}

#[tauri::command]
fn get_sources() -> Value {
    let lim = scan::claude_limits_file();
    let lim_mtime = std::fs::metadata(&lim)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let roots = |v: Vec<PathBuf>| -> Vec<Value> {
        v.into_iter()
            .map(|p| json!({ "path": p.to_string_lossy(), "exists": p.exists() }))
            .collect()
    };
    json!({
        "claude": roots(scan::claude_roots()),
        "codex": roots(scan::codex_roots()),
        "claudeLimitsFile": lim.to_string_lossy(),
        "claudeLimitsMtime": lim_mtime,
    })
}

fn setting_bool(ui: &Value, key: &str, default: bool) -> bool {
    ui.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// Polls live limit sources and status pages, at most every `liveSecs` seconds.
fn refresh_live(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let Ok(conn) = db::open(&state.db_path) else { return };
    let ui = ui_settings(&conn);
    let every = ui.get("liveSecs").and_then(|v| v.as_i64()).unwrap_or(300).clamp(60, 3600) * 1000;
    let now = chrono::Utc::now().timestamp_millis();
    {
        let mut last = state.last_live.lock().unwrap();
        if !force && now - *last < every {
            return;
        }
        *last = now;
    }
    let outcome = |r: Result<Value, String>| match r {
        Ok(v) => json!({ "ok": true, "ts": now, "info": v }),
        Err(e) => json!({ "ok": false, "ts": now, "error": e }),
    };
    let claude = if setting_bool(&ui, "claudeApi", false) {
        outcome(live::claude_usage(&conn).map(|n| json!({ "windows": n })))
    } else {
        Value::Null
    };
    let codex = if setting_bool(&ui, "codexLive", true) { outcome(live::codex_limits(&conn)) } else { Value::Null };
    let status = if setting_bool(&ui, "serviceStatus", true) { live::service_status() } else { Value::Null };
    *state.live.lock().unwrap() = json!({ "claude": claude, "codex": codex, "status": status });
}

fn start_scanner(app: AppHandle, rx: std::sync::mpsc::Receiver<()>) {
    std::thread::spawn(move || loop {
        let state = app.state::<AppState>();
        let db_path = state.db_path.clone();
        let app2 = app.clone();
        let mut report = |s: &ScanStatus| {
            *app2.state::<AppState>().status.lock().unwrap() = s.clone();
            let _ = app2.emit("scan-status", s.clone());
        };
        if let Ok(conn) = db::open(&db_path) {
            let _ = remote::refresh(&conn, false); // offline is fine: keep the last table
        }
        let requested_refresh = state.cloud.take_refresh_request();
        refresh_live(&app, requested_refresh.is_some());
        let result = scan::run_scan(&db_path, &mut report);
        *state.status.lock().unwrap() = result.clone();
        let _ = app.emit("data-updated", result.clone());
        if result.last_error.is_empty() {
            if let Some(context) = state.cloud.snapshot_context() {
                if let Ok(conn) = db::open(&db_path) {
                    if let Ok(dashboard) = stats::dashboard(&conn) {
                        let mut live = state.live.lock().unwrap().clone();
                        if let Some(info) = db::get_setting(&conn, "codex_live").and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
                            live["codexInfo"] = info;
                        }
                        let hooked = statusline::status().get("connected").and_then(Value::as_bool).unwrap_or(false);
                        state.cloud.publish(context, result.last_scan_ms, dashboard, pricing_info(&conn), ui_settings(&conn), live, hooked, requested_refresh.clone());
                    } else {
                        state.cloud.return_refresh_request(requested_refresh);
                    }
                } else {
                    state.cloud.return_refresh_request(requested_refresh);
                }
            }
        } else {
            state.cloud.return_refresh_request(requested_refresh);
        }
        let secs = db::open(&db_path)
            .ok()
            .and_then(|c| ui_settings(&c).get("refreshSecs").and_then(|v| v.as_u64()))
            .unwrap_or(60)
            .clamp(10, 3600);
        // Wait for the interval, or wake early on a manual refresh.
        let _ = rx.recv_timeout(Duration::from_secs(secs));
        while rx.try_recv().is_ok() {}
    });
}

#[tauri::command]
fn get_live(state: State<AppState>) -> Value {
    let mut v = state.live.lock().unwrap().clone();
    if let Ok(conn) = db::open(&state.db_path) {
        if let Some(info) = db::get_setting(&conn, "codex_live").and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            v["codexInfo"] = info;
        }
    }
    v
}

/// Re-query live limits now (ignores the polling interval), then rescan.
#[tauri::command]
async fn refresh_live_now(app: AppHandle) -> Value {
    let a = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || refresh_live(&a, true)).await;
    let state = app.state::<AppState>();
    let _ = state.trigger.lock().unwrap().send(());
    let v = state.live.lock().unwrap().clone();
    v
}

#[tauri::command]
fn update_tray(app: AppHandle, tooltip: String, bars: Vec<tray::TrayBar>) {
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_tooltip(Some(tooltip));
        if !bars.is_empty() {
            let _ = t.set_icon(Some(tray::render(&bars)));
        }
    }
}

#[tauri::command]
fn export_data(state: State<AppState>, kind: String, path: String) -> Result<usize, String> {
    let conn = db::open(&state.db_path).map_err(err)?;
    export::export(&conn, &kind, std::path::Path::new(&path))
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just brings the running window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("usage.db");
            db::open(&db_path)?;
            let (tx, rx) = channel();
            let cloud_app = app.handle().clone();
            let cloud = cloud::CloudSync::start(db_path.clone(), tx.clone(), std::sync::Arc::new(move |event| {
                let _ = cloud_app.emit(event, ());
            }));
            app.manage(AppState {
                db_path,
                status: Mutex::new(ScanStatus::default()),
                trigger: Mutex::new(tx),
                live: Mutex::new(json!({})),
                last_live: Mutex::new(0),
                cloud,
            });

            // Started with Windows (autostart passes --minimized): stay in the tray.
            if !std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }

            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "지금 새로고침", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Token View")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => show_main(app),
                    "refresh" => {
                        let _ = app.state::<AppState>().trigger.lock().unwrap().send(());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            start_scanner(app.handle().clone(), rx);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let to_tray = db::open(&state.db_path)
                    .ok()
                    .and_then(|c| ui_settings(&c).get("closeToTray").and_then(|v| v.as_bool()))
                    .unwrap_or(true);
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard,
            get_status,
            rescan,
            rebuild,
            get_pricing,
            set_pricing,
            get_settings,
            set_settings,
            get_sources,
            refresh_pricing,
            statusline_status,
            statusline_connect,
            get_live,
            refresh_live_now,
            update_tray,
            export_data,
            cloud_status,
            cloud_configure,
            cloud_sign_in,
            cloud_sign_out,
            cloud_sync_now
        ])
        .run(tauri::generate_context!())
        .expect("error while running Token View");
}

/// Headless scan used by `cargo run --example scan` for verification.
#[doc(hidden)]
pub fn cli_scan(db_path: &std::path::Path) -> Value {
    let st = scan::run_scan(db_path, &mut |_| {});
    let conn = db::open(db_path).unwrap();
    json!({ "status": st, "dashboard": stats::dashboard(&conn).unwrap() })
}

/// Same payloads the UI requests over IPC, bundled for browser-only development.
#[doc(hidden)]
pub fn cli_snapshot(db_path: &std::path::Path) -> Value {
    let st = scan::run_scan(db_path, &mut |_| {});
    let conn = db::open(db_path).unwrap();
    json!({
        "get_dashboard": stats::dashboard(&conn).unwrap(),
        "get_status": st,
        "get_pricing": pricing_info(&conn),
        "get_settings": ui_settings(&conn),
        "get_sources": get_sources(),
    })
}

#[doc(hidden)]
pub fn builtin_pricing_json() -> String {
    serde_json::to_string_pretty(&Pricing::default()).unwrap()
}

/// Codex live limits + status pages against a scratch DB (`cargo run --example live`).
#[doc(hidden)]
pub fn cli_live(db_path: &std::path::Path) -> Value {
    let conn = db::open(db_path).unwrap();
    json!({ "codex": live::codex_limits(&conn).map_err(|e| e), "status": live::service_status() })
}
