//! The IPC surface exposed to the WebView. Each command is a thin wrapper over [`AppState`];
//! the names here must match `build.rs` (which gates them) and the capability files.

use bytes::Bytes;
use photobooth_core::{CameraId, Region, SessionState, Settings, SettingsPatch};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::dto::{
    CameraInfo, CommandError, Fault, OutboxEntry, OutboxStatus, PortalEvent, PortalStatus,
};
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

/// Enrolment and the selected event. Never the credential.
#[tauri::command]
pub fn portal_status(state: State<'_, AppState>) -> PortalStatus {
    state.portal_status()
}

#[tauri::command]
pub async fn portal_enrol(
    state: State<'_, AppState>,
    url: String,
    code: String,
    name: String,
) -> CommandResult<PortalStatus> {
    state.portal_enrol(&url, &code, &name).await
}

/// Deletes the credential; the UI confirms first.
#[tauri::command]
pub async fn portal_unenrol(state: State<'_, AppState>) -> CommandResult<PortalStatus> {
    state.portal_unenrol().await
}

/// The portal's OPEN events.
#[tauri::command]
pub async fn portal_events(state: State<'_, AppState>) -> CommandResult<Vec<PortalEvent>> {
    state.portal_events().await
}

/// Re-fetches the event and selects it only if it is OPEN; the UI confirms first.
#[tauri::command]
pub async fn portal_select_event(
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<PortalStatus> {
    state.portal_select_event(&id).await
}

#[tauri::command]
pub async fn portal_clear_event(state: State<'_, AppState>) -> CommandResult<PortalStatus> {
    state.portal_clear_event().await
}

/// Upload queue counts and flags; changes arrive as `portal://outbox` events. It waits for
/// the outbox's lock, which the upload loop holds across `fsync`s, and reads free space, so
/// it runs on a blocking thread (a sync command would run on the main thread).
#[tauri::command]
pub async fn outbox_status(state: State<'_, AppState>) -> CommandResult<OutboxStatus> {
    let Ok(uploads) = state.uploads() else {
        return Ok(state.outbox_status());
    };
    run_blocking(move || Ok(uploads.status())).await
}

/// The needs-attention list with reasons. IDs only, never image bytes. Blocking, like
/// `outbox_status`.
#[tauri::command]
pub async fn outbox_items(state: State<'_, AppState>) -> CommandResult<Vec<OutboxEntry>> {
    let Ok(uploads) = state.uploads() else {
        return Ok(state.outbox_items());
    };
    run_blocking(move || Ok(uploads.entries())).await
}

/// Queues a stopped upload again. Blocking file I/O, so it runs off the async workers.
#[tauri::command]
pub async fn outbox_retry(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    let uploads = state.uploads()?;
    run_blocking(move || uploads.retry(&id)).await
}

/// Deletes the booth's copy of a stopped upload; the UI confirms first.
#[tauri::command]
pub async fn outbox_dismiss(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    let uploads = state.uploads()?;
    run_blocking(move || uploads.dismiss(&id)).await
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| CommandError::new(format!("the upload queue task failed: {err}")))?
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
