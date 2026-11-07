//! Android home-screen widget; other platforms accept updates as no-ops.
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[tauri::command]
async fn update<R: Runtime>(app: AppHandle<R>, json: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>("update", serde_json::json!({ "json": json }))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, json);
        Ok(())
    }
}

#[tauri::command]
async fn clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Native<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>("clear", serde_json::json!({}))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("limits-widget")
        .invoke_handler(tauri::generate_handler![update, clear])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("com.tokenview.widget", "LimitsWidgetPlugin")?;
                _app.manage(Native(handle));
            }
            Ok(())
        })
        .build()
}
