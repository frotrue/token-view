//! Google authorization through Google Play services (Identity AuthorizationClient).
//! The first call shows the account/consent screen; later calls return a fresh
//! access token silently, so the app never asks again every hour like the web.
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Returns `{ accessToken, scopes }`. With `interactive = false` it fails with
/// `consent_required` instead of showing any UI.
#[tauri::command]
async fn authorize<R: Runtime>(app: AppHandle<R>, interactive: bool) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let native = app.state::<Native<R>>();
        native
            .0
            .run_mobile_plugin::<serde_json::Value>("authorize", serde_json::json!({ "interactive": interactive }))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, interactive);
        Err("Google sign-in through Play services is only available on Android".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("google-auth")
        .invoke_handler(tauri::generate_handler![authorize])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("com.tokenview.googleauth", "GoogleAuthPlugin")?;
                _app.manage(Native(handle));
            }
            Ok(())
        })
        .build()
}
