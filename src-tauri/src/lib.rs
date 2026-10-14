mod db;
mod pricing;
mod remote;
mod scan;
mod stats;
pub mod statusline;

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
    let conn = db::open(&state.db_path).map_err(err)?;
    db::set_setting(&conn, "ui", &settings.to_string()).map_err(err)
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

/// Short tray tooltip: today's API-equivalent spend.
fn tray_text(db_path: &PathBuf) -> String {
    let Ok(conn) = db::open(db_path) else { return "Token View".into() };
    let today: (f64, i64) = conn
        .query_row(
            "SELECT coalesce(sum(cost),0), coalesce(sum(input+cache_write_5m+cache_write_1h+cache_read+output),0)
             FROM events WHERE date(ts/1000,'unixepoch','localtime') = date('now','localtime')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0.0, 0));
    format!("Token View\n오늘 ${:.2} · {:.1}M 토큰", today.0, today.1 as f64 / 1e6)
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
        let result = scan::run_scan(&db_path, &mut report);
        *state.status.lock().unwrap() = result.clone();
        let _ = app.emit("data-updated", result);
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(tray_text(&db_path)));
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("usage.db");
            db::open(&db_path)?;
            let (tx, rx) = channel();
            app.manage(AppState {
                db_path,
                status: Mutex::new(ScanStatus::default()),
                trigger: Mutex::new(tx),
            });

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
            statusline_connect
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
