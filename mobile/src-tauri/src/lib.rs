//! The phone app is a reader: the UI fetches the PC's snapshot from Google Drive or
//! a private GitHub repository itself. Native code provides Google sign-in,
//! installing app updates, and the limits home-screen widget.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_apk_update::init())
        .plugin(tauri_plugin_limits_widget::init())
        .run(tauri::generate_context!())
        .expect("error while running Token View");
}
