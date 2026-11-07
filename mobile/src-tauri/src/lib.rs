//! The phone app is a reader: the UI fetches the PC's snapshot from Google Drive or
//! a private GitHub repository itself. Native code provides Google sign-in, the
//! limits home-screen widget and, in the sideloaded build, installing app updates.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_limits_widget::init());
    #[cfg(feature = "github-updates")]
    let builder = builder.plugin(tauri_plugin_apk_update::init());
    builder
        .run(tauri::generate_context!())
        .expect("error while running Token View");
}
