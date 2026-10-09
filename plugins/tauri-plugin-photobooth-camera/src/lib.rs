//! Android camera and USB-host support for the Photobooth app.
//!
//! - **Native device camera** — CameraX renders a preview in a view *behind* a transparent
//!   WebView (the pattern of Tauri's official `barcode-scanner` plugin); captures are written
//!   to the cache dir and handed back as a path.
//! - **USB host** — Kotlin discovers the Sony camera, obtains USB permission and opens it, then
//!   hands Rust a file descriptor that the `sony-ptp` engine drives through libusb.
//!
//! Only window behaviour and the back-button listener are exposed to the WebView. The camera
//! and USB commands are driven from Rust, so the least-trusted layer cannot reach the hardware.
//!
//! On non-Android targets every native call returns [`Error::Unsupported`]; the plugin still
//! registers so the app's capability file resolves identically on every platform.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

mod commands;
mod error;
mod models;

#[cfg(not(target_os = "android"))]
mod desktop;
#[cfg(target_os = "android")]
mod mobile;

#[cfg(feature = "core-camera")]
pub mod camera;
#[cfg(feature = "core-camera")]
pub mod gesture;
#[cfg(feature = "sony-transport")]
pub mod usb;

pub use error::{Error, Result};
pub use models::*;

#[cfg(not(target_os = "android"))]
pub use desktop::PhotoboothCamera;
#[cfg(target_os = "android")]
pub use mobile::PhotoboothCamera;

/// Access to the plugin's native handle from any `Manager` (an `AppHandle`, `App`, window…).
pub trait PhotoboothCameraExt<R: Runtime> {
    fn photobooth_camera(&self) -> &PhotoboothCamera<R>;
}

impl<R: Runtime, T: Manager<R>> PhotoboothCameraExt<R> for T {
    fn photobooth_camera(&self) -> &PhotoboothCamera<R> {
        self.state::<PhotoboothCamera<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("photobooth-camera")
        .invoke_handler(tauri::generate_handler![
            commands::window_set_keep_screen_on,
            commands::window_set_immersive,
            commands::register_listener,
            commands::remove_listener,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let camera = mobile::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let camera = desktop::init(app, api)?;
            app.manage(camera);
            Ok(())
        })
        .build()
}
