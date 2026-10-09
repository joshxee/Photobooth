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

use std::sync::atomic::{AtomicBool, Ordering};

use photobooth_core::{CameraId, Timings};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;
use tracing::Level;
use tracing_subscriber::filter::filter_fn;
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

/// Presence of this file in the app data directory turns on full `sony_ptp` protocol tracing
/// (every PTP command and response). Create it from a shell, e.g.
/// `adb shell run-as com.jc.photobooth.tauri touch debug-ptp`, then restart the app.
const PTP_TRACE_FLAG: &str = "debug-ptp";

static PTP_TRACE: AtomicBool = AtomicBool::new(false);

/// Per-target verbosity: our own crates at DEBUG, the PTP engine at TRACE when requested, and
/// everything else at INFO.
fn log_enabled(meta: &tracing::Metadata<'_>) -> bool {
    let target = meta.target();
    let max = if target.starts_with("sony_ptp") {
        if PTP_TRACE.load(Ordering::Relaxed) {
            Level::TRACE
        } else {
            Level::DEBUG
        }
    } else if target.starts_with("photobooth") {
        Level::DEBUG
    } else {
        Level::INFO
    };
    *meta.level() <= max
}

fn init_tracing(logs: LogRingBuffer) {
    let ring = tracing_subscriber::fmt::layer()
        .with_writer(logs)
        .with_ansi(false)
        .with_filter(filter_fn(log_enabled));
    let console = tracing_subscriber::fmt::layer()
        .with_writer(console_writer())
        .with_ansi(false)
        .with_filter(filter_fn(log_enabled));
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

    let mut gesture = state.subscribe_gesture();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while gesture.changed().await.is_ok() {
            let update = *gesture.borrow_and_update();
            let _ = handle.emit("gesture://state", &update);
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
            if data_dir.join(PTP_TRACE_FLAG).exists() {
                PTP_TRACE.store(true, Ordering::Relaxed);
                tracing::info!("PTP protocol tracing is on ({PTP_TRACE_FLAG} flag present)");
            }
            let (state, session_task) = AppState::new(
                data_dir.join(SETTINGS_FILE),
                platform_slots(app.handle()),
                logs,
                Timings::default(),
            );
            tauri::async_runtime::spawn(session_task);
            spawn_event_forwarders(app.handle(), &state);
            // The tablet's recognizer; desktop has none, so only the developer panel's palm counts.
            #[cfg(target_os = "android")]
            let native: Option<std::sync::Arc<dyn photobooth_core::PalmDetector>> = {
                use tauri_plugin_photobooth_camera::gesture::NativePalmDetector;
                Some(std::sync::Arc::new(NativePalmDetector::new(
                    std::sync::Arc::new(app.handle().clone()),
                )))
            };
            #[cfg(not(target_os = "android"))]
            let native = None;
            tauri::async_runtime::spawn(state.gesture_sampler(native));
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
            commands::gesture_set_region,
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
