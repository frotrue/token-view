fn main() {
    // capabilities/apk-update.json grants a plugin that only the sideloaded
    // (`github-updates`) build links, so the Google Play build must not load it.
    println!("cargo:rerun-if-changed=capabilities");
    let attributes = tauri_build::Attributes::new();
    let attributes = if std::env::var_os("CARGO_FEATURE_GITHUB_UPDATES").is_some() {
        attributes.capabilities_path_pattern("./capabilities/*.json")
    } else {
        attributes.capabilities_path_pattern("./capabilities/default.json")
    };
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
