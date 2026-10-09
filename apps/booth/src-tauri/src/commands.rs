//! The IPC surface exposed to the WebView. Each command is a thin wrapper over [`AppState`];
//! the names here must match `build.rs` (which gates them) and the capability files.

use bytes::Bytes;
use photobooth_core::{CameraId, Region, SessionState, Settings, SettingsPatch};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::dto::{CameraInfo, CommandError, Fault};
use crate::state::{AppState, FrameSink};

type CommandResult<T> = Result<T, CommandError>;

/// Delivers raw JPEG bytes over a Tauri channel (never base64 through JSON).
struct ChannelSink(Channel<InvokeResponseBody>);

impl FrameSink for ChannelSink {
    fn send(&mut self, frame: Bytes) -> bool {
        self.0.send(InvokeResponseBody::Raw(frame.to_vec())).is_ok()
    }
}

#[tauri::command]
pub async fn camera_list(state: State<'_, AppState>) -> CommandResult<Vec<CameraInfo>> {
    Ok(state.list_cameras().await)
}

#[tauri::command]
pub async fn camera_select(state: State<'_, AppState>, id: CameraId) -> CommandResult<()> {
    state.select_camera(id).await
}

#[tauri::command]
pub async fn camera_connect(state: State<'_, AppState>) -> CommandResult<()> {
    state.connect_camera().await
}

#[tauri::command]
pub async fn camera_disconnect(state: State<'_, AppState>) -> CommandResult<()> {
    state.disconnect_camera().await
}

#[tauri::command]
pub async fn live_view_start(
    state: State<'_, AppState>,
    channel: Channel<InvokeResponseBody>,
) -> CommandResult<()> {
    state.start_live_view(Box::new(ChannelSink(channel))).await
}

#[tauri::command]
pub async fn live_view_stop(state: State<'_, AppState>) -> CommandResult<()> {
    state.stop_live_view().await;
    Ok(())
}

/// The UI reports where the guest's palm box sits in the camera frame (fractions, unmirrored).
#[tauri::command]
pub fn gesture_set_region(
    state: State<'_, AppState>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) -> CommandResult<()> {
    let region = Region::new(x, y, w, h)
        .ok_or_else(|| CommandError::new("the palm box must lie inside the camera frame"))?;
    state.set_gesture_region(region);
    Ok(())
}

#[tauri::command]
pub fn session_start(state: State<'_, AppState>) {
    state.session_start();
}

#[tauri::command]
pub async fn session_cancel(state: State<'_, AppState>) -> CommandResult<()> {
    state.session_cancel().await
}

#[tauri::command]
pub async fn session_take_another(state: State<'_, AppState>) -> CommandResult<()> {
    state.session_take_another().await
}

#[tauri::command]
pub async fn session_return_home(state: State<'_, AppState>) -> CommandResult<()> {
    state.session_return_home().await
}

/// The current session state, for a WebView that (re)loads mid-session. Subsequent changes
/// arrive as `session://state` events.
#[tauri::command]
pub fn session_state(state: State<'_, AppState>) -> SessionState {
    state.session_state()
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, patch: SettingsPatch) -> CommandResult<Settings> {
    state.update_settings(patch)
}

/// Developer-panel fault injection. Only reachable through the `dev` capability.
#[tauri::command]
pub async fn test_inject(state: State<'_, AppState>, fault: Fault) -> CommandResult<()> {
    state.inject(fault).await
}

/// Recent log lines. Only reachable through the `dev` capability.
#[tauri::command]
pub fn logs_recent(state: State<'_, AppState>, limit: Option<usize>) -> Vec<String> {
    state.recent_logs(limit.unwrap_or(200))
}
