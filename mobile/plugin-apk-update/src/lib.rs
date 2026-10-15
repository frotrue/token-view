//! In-app updates for the sideloaded APK. The UI finds a newer release on GitHub;
//! this downloads that APK and hands it to the system installer. Android only
//! accepts it as an update when it is signed with the same key as the installed app.
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Downloads `url` (a Token View release asset) and opens the installer. Resolves
/// once the installer screen is shown; the user confirms the update there.
#[tauri::command]
async fn install<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let native = app.state::<Native<R>>();
        native
            .0
            .run_mobile_plugin::<serde_json::Value>("install", serde_json::json!({ "url": url }))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, url);
        Err("APK updates are only available on Android".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-update")
        .invoke_handler(tauri::generate_handler![install])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("com.tokenview.apkupdate", "ApkUpdatePlugin")?;
                _app.manage(Native(handle));
            }
            Ok(())
        })
        .build()
}
