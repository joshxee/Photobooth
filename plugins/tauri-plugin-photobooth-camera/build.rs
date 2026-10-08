// Only commands the WebView may call are listed. Everything the Rust side drives directly
// (`usb*`, `cam*`) is reachable from Rust only, so the WebView has no path to the camera
// hardware beyond window behaviour and the back-button listener.
const COMMANDS: &[&str] = &[
    "window_set_keep_screen_on",
    "window_set_immersive",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
