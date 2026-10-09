//! The only commands the WebView may call (see `build.rs`).

use tauri::ipc::Channel;
use tauri::{command, AppHandle, Runtime};

use crate::{PhotoboothCameraExt, Result};

#[command]
pub(crate) async fn window_set_keep_screen_on<R: Runtime>(
    app: AppHandle<R>,
    on: bool,
) -> Result<()> {
    app.photobooth_camera().window_set_keep_screen_on(on).await
}

#[command]
pub(crate) async fn window_set_immersive<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<()> {
    app.photobooth_camera().window_set_immersive(on).await
}

/// Backs `addPluginListener` (used for `backPressed`, `usbAttached`, `usbDetached`).
#[command]
pub(crate) async fn register_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    handler: Channel<serde_json::Value>,
) -> Result<()> {
    app.photobooth_camera()
        .register_listener(event, handler)
        .await
}

#[command]
pub(crate) async fn remove_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    channel_id: u32,
) -> Result<()> {
    app.photobooth_camera()
        .remove_listener(event, channel_id)
        .await
}
