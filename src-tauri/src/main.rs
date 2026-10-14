// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Code invokes `token-view --statusline` for every status line refresh.
    if std::env::args().any(|a| a == "--statusline") {
        token_view_lib::statusline::run();
        return;
    }
    token_view_lib::run()
}
