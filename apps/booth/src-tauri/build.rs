fn main() {
    // Only the commands listed here are exposed to the WebView, and each needs an explicit
    // `allow-*` permission in a capability file.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "camera_list",
        "camera_select",
        "camera_connect",
        "camera_disconnect",
        "live_view_start",
        "live_view_stop",
        "session_start",
        "session_cancel",
        "session_take_another",
        "session_return_home",
        "session_state",
        "settings_get",
        "settings_set",
        "test_inject",
        "logs_recent",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
