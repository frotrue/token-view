//! Small always-on-top overlay with the current limits, toggled from the tray or
//! settings. Its visibility and position live in the settings table so it comes back
//! where the user left it.

use crate::{db, AppState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, Wry};

pub const LABEL: &str = "hud";
static SAVE_PENDING: AtomicBool = AtomicBool::new(false);

/// The tray's "HUD" check item, kept in sync when the HUD is toggled elsewhere.
pub struct TrayItem(pub CheckMenuItem<Wry>);

pub fn enabled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    db::open(&state.db_path).ok().and_then(|c| db::get_setting(&c, "hud")).is_some_and(|v| v == "true")
}

fn saved_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let state = app.state::<AppState>();
    let s = db::get_setting(&db::open(&state.db_path).ok()?, "hud_pos")?;
    let (x, y) = s.split_once(',')?;
    let p = PhysicalPosition::new(x.trim().parse().ok()?, y.trim().parse().ok()?);
    // A monitor that was unplugged would leave the HUD somewhere unreachable.
    let on_screen = app.available_monitors().ok()?.iter().any(|m| {
        let (o, z) = (m.position(), m.size());
        p.x + 20 >= o.x && p.x + 20 < o.x + z.width as i32 && p.y + 10 >= o.y && p.y + 10 < o.y + z.height as i32
    });
    on_screen.then_some(p)
}

/// Top center of the primary monitor.
fn default_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let m = app.primary_monitor().ok()??;
    let scale = m.scale_factor();
    Some(PhysicalPosition::new(
        m.position().x + m.size().width as i32 / 2 - (150.0 * scale) as i32,
        m.position().y + (8.0 * scale) as i32,
    ))
}

pub fn set_visible(app: &AppHandle, show: bool) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        if show { w.show()? } else { w.hide()? }
    } else if show {
        let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Token View HUD")
            .inner_size(300.0, 40.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()?;
        if let Some(p) = saved_position(app).or_else(|| default_position(app)) {
            w.set_position(p)?;
        }
        w.show()?;
    }
    let state = app.state::<AppState>();
    if let Ok(c) = db::open(&state.db_path) {
        let _ = db::set_setting(&c, "hud", if show { "true" } else { "false" });
    }
    if let Some(item) = app.try_state::<TrayItem>() {
        let _ = item.0.set_checked(show);
    }
    let _ = app.emit("hud-changed", show);
    Ok(())
}

/// Called on every move event while dragging; writes the last one once things settle.
pub fn remember_position(app: &AppHandle) {
    if SAVE_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        SAVE_PENDING.store(false, Ordering::SeqCst);
        let Some(p) = app.get_webview_window(LABEL).and_then(|w| w.outer_position().ok()) else { return };
        let state = app.state::<AppState>();
        if let Ok(c) = db::open(&state.db_path) {
            let _ = db::set_setting(&c, "hud_pos", &format!("{},{}", p.x, p.y));
        }
    });
}
