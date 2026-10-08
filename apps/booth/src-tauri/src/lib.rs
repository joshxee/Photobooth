//! Photobooth: a Tauri v2 app whose Rust core owns all business logic. The WebView only
//! renders state it receives over IPC.

#[cfg(any(target_os = "android", test))]
mod android;
mod commands;
mod dto;
#[cfg(target_os = "android")]
mod logcat;
mod logs;
mod protocol;
mod state;

#[cfg(target_os = "android")]
use std::sync::Arc;

use photobooth_core::{CameraId, Timings};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::prelude::*;

use crate::dto::{CameraStatusEvent, PreviewKind};
use crate::logs::LogRingBuffer;
#[cfg(target_os = "android")]
use crate::state::AlwaysAvailable;
#[cfg(not(target_os = "android"))]
use crate::state::Unavailable;
use crate::state::{AppState, CameraSlot};

const SETTINGS_FILE: &str = "settings.json";
const LOG_LINES: usize = 500;

/// Where console logs go: stderr on desktop, logcat on Android (stderr is not captured there).
#[cfg(not(target_os = "android"))]
fn console_writer() -> impl for<'a> MakeWriter<'a> + Send + Sync + 'static {
    std::io::stderr
}

#[cfg(target_os = "android")]
fn console_writer() -> impl for<'a> MakeWriter<'a> + Send + Sync + 'static {
    logcat::Logcat
}

fn init_tracing(logs: LogRingBuffer) {
    let filter = Targets::new()
        .with_default(LevelFilter::INFO)
        .with_target("photobooth_lib", LevelFilter::DEBUG)
        .with_target("photobooth_core", LevelFilter::DEBUG)
        .with_target("sony_ptp", LevelFilter::DEBUG);
    let ring = tracing_subscriber::fmt::layer()
        .with_writer(logs)
        .with_ansi(false)
        .with_filter(filter.clone());
    let console = tracing_subscriber::fmt::layer()
        .with_writer(console_writer())
        .with_ansi(false)
        .with_filter(filter);
    // Ignore the error: a subscriber may already be installed (e.g. in tests).
    let _ = tracing_subscriber::registry()
        .with(ring)
        .with(console)
        .try_init();
}

/// Cameras that depend on the platform. On desktop only the test camera works; the others are
/// listed as unavailable with a reason rather than erroring.
#[cfg(not(target_os = "android"))]
fn platform_slots(_app: &AppHandle) -> Vec<CameraSlot> {
    let tablet_only = "Only available on the Android tablet";
    vec![
        CameraSlot {
            id: CameraId::DEVICE,
            name: "Device Camera",
            preview: PreviewKind::Native,
            provider: Box::new(Unavailable::new(CameraId::DEVICE, tablet_only)),
        },
        CameraSlot {
            id: CameraId::SONY_USB,
            name: "Sony A7 III (USB)",
            preview: PreviewKind::Channel,
            provider: Box::new(Unavailable::new(CameraId::SONY_USB, tablet_only)),
        },
    ]
}

/// On Android: the device camera (CameraX behind the WebView) and the wired Sony. The Sony is
/// not built here — there is no device at startup — but lazily when it is connected; until a
/// cable is plugged in `camera_list` reports it as unavailable with a reason.
#[cfg(target_os = "android")]
fn platform_slots(app: &AppHandle) -> Vec<CameraSlot> {
    use tauri_plugin_photobooth_camera::camera::NativeCamera;
    use tauri_plugin_photobooth_camera::usb::{AndroidUsbFactory, UsbSonyCamera};

    let backend = Arc::new(app.clone());
    let settings_source = app.clone();
    let device = Arc::new(NativeCamera::new(backend.clone(), move || {
        // Read when the preview starts, so a settings change applies without a restart.
        settings_source
            .try_state::<AppState>()
            .is_none_or(|state| state.settings().mirror_preview)
    }));
    let sony = Arc::new(UsbSonyCamera::new(backend, Arc::new(AndroidUsbFactory)));
    vec![
        CameraSlot {
            id: CameraId::DEVICE,
            name: "Device Camera",
            preview: PreviewKind::Native,
            provider: Box::new(AlwaysAvailable(device)),
        },
        CameraSlot {
            id: CameraId::SONY_USB,
            name: "Sony A7 III (USB)",
            preview: PreviewKind::Channel,
            provider: Box::new(android::SonyUsbProvider(sony)),
        },
    ]
}

/// Forwards session and camera state changes to the WebView as events.
fn spawn_event_forwarders(app: &AppHandle, state: &AppState) {
    let mut sessions = state.subscribe_session();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match sessions.recv().await {
                Ok(session) => {
                    let _ = handle.emit("session://state", &session);
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "session event forwarder lagged; resending state");
                    let current = handle.state::<AppState>().session_state();
                    let _ = handle.emit("session://state", &current);
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    for (camera, mut status) in state.camera_status_feeds() {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while status.changed().await.is_ok() {
                let event = CameraStatusEvent {
                    camera: camera.clone(),
                    status: status.borrow_and_update().clone(),
                };
                let _ = handle.emit("camera://status", &event);
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let logs = LogRingBuffer::new(LOG_LINES);
    init_tracing(logs.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_photobooth_camera::init())
        // Photos are served from memory only; nothing is ever read from disk.
        .register_uri_scheme_protocol("booth", |ctx, request| {
            match ctx.app_handle().try_state::<AppState>() {
                Some(state) => protocol::respond(state.photos(), &request.uri().to_string()),
                None => protocol::respond(&photobooth_core::PhotoStore::new(), ""),
            }
        })
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let (state, session_task) = AppState::new(
                data_dir.join(SETTINGS_FILE),
                platform_slots(app.handle()),
                logs,
                Timings::default(),
            );
            tauri::async_runtime::spawn(session_task);
            spawn_event_forwarders(app.handle(), &state);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::camera_list,
            commands::camera_select,
            commands::camera_connect,
            commands::camera_disconnect,
            commands::live_view_start,
            commands::live_view_stop,
            commands::session_start,
            commands::session_cancel,
            commands::session_take_another,
            commands::session_return_home,
            commands::session_state,
            commands::settings_get,
            commands::settings_set,
            commands::test_inject,
            commands::logs_recent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Photobooth app");
}
