// Desktop entry for `tauri dev` previews; the phone uses the library entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    token_view_mobile_lib::run()
}
