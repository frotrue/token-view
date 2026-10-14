//! Writes a dashboard snapshot for UI development outside Tauri.
fn main() {
    let db = std::env::args().nth(1).expect("db path");
    let out = std::env::args().nth(2).expect("output json");
    let v = token_view_lib::cli_snapshot(std::path::Path::new(&db));
    std::fs::write(out, serde_json::to_string(&v).unwrap()).unwrap();
}
