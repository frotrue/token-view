//! The phone app is a reader: the UI fetches the PC's snapshot from Google Drive or
//! a private GitHub repository itself. Native code only provides Google sign-in and
//! installing app updates.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_apk_update::init())
        .run(tauri::generate_context!())
        .expect("error while running Token View");
}
