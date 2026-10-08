//! `AppState`: everything the commands do, with no dependency on Tauri types so it can be
//! unit tested directly. The commands in `commands.rs` are thin wrappers around these methods.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{FutureExt, StreamExt};
use photobooth_core::{
    Camera, CameraId, CameraStatus, DevPanelTrigger, FrameStream, MockCamera, MockCameraHandle,
    PhotoStore, Session, SessionContext, SessionHandle, SessionState, SessionTask, Settings,
    SettingsPatch, SettingsStore, StartTrigger, TapTrigger, Timings,
};
#[cfg(any(not(target_os = "android"), test))]
use photobooth_core::{CameraError, CapturedPhoto};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use crate::dto::{CameraInfo, CommandError, Fault, PreviewKind};
use crate::logs::LogRingBuffer;

/// Decides whether a camera can be used right now and hands out its `Camera`.
#[async_trait]
pub trait CameraProvider: Send + Sync {
    /// `None` when usable; otherwise a human-readable reason it is not.
    async fn unavailable_reason(&self) -> Option<String>;
    fn camera(&self) -> Arc<dyn Camera>;
}

/// A camera that is always usable.
pub struct AlwaysAvailable(pub Arc<dyn Camera>);

#[async_trait]
impl CameraProvider for AlwaysAvailable {
    async fn unavailable_reason(&self) -> Option<String> {
        None
    }
    fn camera(&self) -> Arc<dyn Camera> {
        self.0.clone()
    }
}

/// A camera that cannot be used on this platform or right now; every operation fails.
/// (Android builds real cameras instead, so this exists there only for tests.)
#[cfg(any(not(target_os = "android"), test))]
pub struct Unavailable {
    camera: Arc<NullCamera>,
    reason: String,
}

#[cfg(any(not(target_os = "android"), test))]
impl Unavailable {
    pub fn new(id: CameraId, reason: impl Into<String>) -> Self {
        Self {
            camera: Arc::new(NullCamera::new(id)),
            reason: reason.into(),
        }
    }
}

#[cfg(any(not(target_os = "android"), test))]
#[async_trait]
impl CameraProvider for Unavailable {
    async fn unavailable_reason(&self) -> Option<String> {
        Some(self.reason.clone())
    }
    fn camera(&self) -> Arc<dyn Camera> {
        self.camera.clone()
    }
}

#[cfg(any(not(target_os = "android"), test))]
struct NullCamera {
    id: CameraId,
    status: watch::Sender<CameraStatus>,
}

#[cfg(any(not(target_os = "android"), test))]
impl NullCamera {
    fn new(id: CameraId) -> Self {
        Self {
            id,
            status: watch::channel(CameraStatus::Disconnected).0,
        }
    }
}

#[cfg(any(not(target_os = "android"), test))]
#[async_trait]
impl Camera for NullCamera {
    fn id(&self) -> CameraId {
        self.id.clone()
    }
    async fn connect(&self) -> Result<(), CameraError> {
        Err(CameraError::NotConnected)
    }
    async fn disconnect(&self) -> Result<(), CameraError> {
        Ok(())
    }
    fn status(&self) -> watch::Receiver<CameraStatus> {
        self.status.subscribe()
    }
    async fn start_live_view(&self) -> Result<FrameStream, CameraError> {
        Err(CameraError::NotConnected)
    }
    async fn stop_live_view(&self) -> Result<(), CameraError> {
        Ok(())
    }
    async fn capture(&self) -> Result<CapturedPhoto, CameraError> {
        Err(CameraError::NotConnected)
    }
}

pub struct CameraSlot {
    pub id: CameraId,
    pub name: &'static str,
    pub preview: PreviewKind,
    pub provider: Box<dyn CameraProvider>,
}

/// Where live-view frames go. Returns `false` when the consumer is gone.
pub trait FrameSink: Send + 'static {
    fn send(&mut self, frame: Bytes) -> bool;
}

struct Shared {
    settings: Mutex<Settings>,
    active: Mutex<CameraId>,
    slots: Vec<CameraSlot>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    fn slot(&self, id: &CameraId) -> Option<&CameraSlot> {
        self.slots.iter().find(|s| &s.id == id)
    }

    fn active_slot(&self) -> Option<&CameraSlot> {
        let id = lock(&self.active).clone();
        self.slot(&id)
    }
}

impl SessionContext for Shared {
    fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    fn camera(&self) -> Option<Arc<dyn Camera>> {
        self.active_slot().map(|slot| slot.provider.camera())
    }
}

pub struct AppState {
    shared: Arc<Shared>,
    settings_store: SettingsStore,
    photos: PhotoStore,
    session: SessionHandle,
    tap: Arc<TapTrigger>,
    dev: Arc<DevPanelTrigger>,
    mock: MockCameraHandle,
    live: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    logs: LogRingBuffer,
}

impl AppState {
    /// Builds the state. `platform_slots` are the cameras that depend on the platform (device
    /// camera, Sony USB); the always-available test camera is appended here. The returned
    /// [`SessionTask`] must be spawned on the app's runtime.
    pub fn new(
        settings_path: PathBuf,
        platform_slots: Vec<CameraSlot>,
        logs: LogRingBuffer,
        timings: Timings,
    ) -> (Self, SessionTask) {
        let settings_store = SettingsStore::new(settings_path);
        let settings = settings_store.load_or_default();

        let mock_camera = MockCamera::new(settings.test_mode.clone());
        let mock = mock_camera.handle();
        let mut slots = platform_slots;
        slots.push(CameraSlot {
            id: CameraId::TEST,
            name: "Test Camera",
            preview: PreviewKind::Channel,
            provider: Box::new(AlwaysAvailable(Arc::new(mock_camera))),
        });

        let shared = Arc::new(Shared {
            active: Mutex::new(settings.selected_camera.clone()),
            settings: Mutex::new(settings),
            slots,
        });
        let photos = PhotoStore::new();
        let tap = TapTrigger::new();
        let dev = DevPanelTrigger::new();
        let triggers: Vec<Arc<dyn StartTrigger>> = vec![tap.clone(), dev.clone()];
        let (session, task) = Session::build(shared.clone(), photos.clone(), timings, triggers);

        (
            Self {
                shared,
                settings_store,
                photos,
                session,
                tap,
                dev,
                mock,
                live: tokio::sync::Mutex::new(None),
                logs,
            },
            task,
        )
    }

    pub fn photos(&self) -> &PhotoStore {
        &self.photos
    }

    pub fn session_state(&self) -> SessionState {
        self.session.state()
    }

    pub fn subscribe_session(&self) -> broadcast::Receiver<SessionState> {
        self.session.subscribe()
    }

    /// Every camera's id with a status receiver, for forwarding `camera://status` events.
    pub fn camera_status_feeds(&self) -> Vec<(CameraId, watch::Receiver<CameraStatus>)> {
        self.shared
            .slots
            .iter()
            .map(|s| (s.id.clone(), s.provider.camera().status()))
            .collect()
    }

    pub fn recent_logs(&self, limit: usize) -> Vec<String> {
        self.logs.recent(limit)
    }

    // ----- settings ---------------------------------------------------------------------

    pub fn settings(&self) -> Settings {
        lock(&self.shared.settings).clone()
    }

    /// Merges, validates and persists `patch`. Nothing changes if any step fails.
    pub fn update_settings(&self, patch: SettingsPatch) -> Result<Settings, CommandError> {
        let mut guard = lock(&self.shared.settings);
        let mut next = guard.clone();
        next.patch(patch)?;
        self.settings_store.save(&next)?;
        self.mock.set_config(next.test_mode.clone());
        *guard = next.clone();
        Ok(next)
    }

    fn reset_settings(&self) -> Result<Settings, CommandError> {
        let mut guard = lock(&self.shared.settings);
        let next = Settings {
            // Resetting must not yank the camera the operator is using.
            selected_camera: guard.selected_camera.clone(),
            ..Settings::default()
        };
        self.settings_store.save(&next)?;
        self.mock.set_config(next.test_mode.clone());
        *guard = next.clone();
        Ok(next)
    }

    // ----- cameras ----------------------------------------------------------------------

    pub async fn list_cameras(&self) -> Vec<CameraInfo> {
        let selected = lock(&self.shared.active).clone();
        let mut out = Vec::with_capacity(self.shared.slots.len());
        for slot in &self.shared.slots {
            let reason = slot.provider.unavailable_reason().await;
            out.push(CameraInfo {
                id: slot.id.clone(),
                name: slot.name.to_owned(),
                available: reason.is_none(),
                reason,
                preview: slot.preview,
                status: slot.provider.camera().status().borrow().clone(),
                selected: slot.id == selected,
            });
        }
        out
    }

    fn active_camera(&self) -> Result<Arc<dyn Camera>, CommandError> {
        self.shared
            .active_slot()
            .map(|slot| slot.provider.camera())
            .ok_or_else(|| CommandError::new("no camera is selected"))
    }

    /// Makes `id` the active camera and remembers the choice. The previous camera is released.
    pub async fn select_camera(&self, id: CameraId) -> Result<(), CommandError> {
        if self.session.state() != SessionState::Attract {
            return Err(CommandError::new(
                "finish or cancel the current session before changing camera",
            ));
        }
        let slot = self
            .shared
            .slot(&id)
            .ok_or_else(|| CommandError::new(format!("unknown camera '{id}'")))?;
        if let Some(reason) = slot.provider.unavailable_reason().await {
            return Err(CommandError::new(reason));
        }

        let previous = lock(&self.shared.active).clone();
        if previous != id {
            self.stop_live_view().await;
            if let Some(old) = self.shared.slot(&previous) {
                // Best effort: the old camera may already be gone.
                let _ = old.provider.camera().disconnect().await;
            }
        }
        *lock(&self.shared.active) = id.clone();
        tracing::info!(camera = %id, "camera selected");
        self.update_settings(SettingsPatch {
            selected_camera: Some(id),
            ..SettingsPatch::default()
        })?;
        Ok(())
    }

    pub async fn connect_camera(&self) -> Result<(), CommandError> {
        let camera = self.active_camera()?;
        tracing::info!(camera = %camera.id(), "connecting");
        camera.connect().await?;
        Ok(())
    }

    pub async fn disconnect_camera(&self) -> Result<(), CommandError> {
        self.stop_live_view().await;
        let camera = self.active_camera()?;
        camera.disconnect().await?;
        Ok(())
    }

    // ----- live view --------------------------------------------------------------------

    /// Starts forwarding live-view frames to `sink`, replacing any previous forwarder. Only
    /// the newest frame is delivered when the camera produces them faster than they are read.
    pub async fn start_live_view(&self, sink: Box<dyn FrameSink>) -> Result<(), CommandError> {
        let camera = self.active_camera()?;
        let stream = camera.start_live_view().await?;
        let task = tokio::spawn(forward_frames(stream, sink));
        if let Some(previous) = self.live.lock().await.replace(task) {
            previous.abort();
        }
        Ok(())
    }

    pub async fn stop_live_view(&self) {
        if let Some(task) = self.live.lock().await.take() {
            task.abort();
        }
        if let Ok(camera) = self.active_camera() {
            let _ = camera.stop_live_view().await;
        }
    }

    // ----- session ----------------------------------------------------------------------

    /// A guest tap on the attract screen.
    pub fn session_start(&self) {
        self.tap.fire();
    }

    pub async fn session_cancel(&self) -> Result<(), CommandError> {
        Ok(self.session.cancel().await?)
    }

    pub async fn session_take_another(&self) -> Result<(), CommandError> {
        Ok(self.session.take_another().await?)
    }

    pub async fn session_return_home(&self) -> Result<(), CommandError> {
        Ok(self.session.return_home().await?)
    }

    // ----- developer panel --------------------------------------------------------------

    pub async fn inject(&self, fault: Fault) -> Result<(), CommandError> {
        tracing::info!(?fault, "test fault injected");
        match fault {
            Fault::FailNextCapture => self.mock.force_fail_next_capture(),
            Fault::DisconnectCamera => self.mock.force_disconnect(),
            Fault::SlowNextCapture { ms } => self.mock.force_slow_next_capture(ms),
            Fault::SkipCountdown => self.session.skip_countdown().await?,
            Fault::StartSession => self.dev.fire(),
            Fault::ResetSettings => {
                self.reset_settings()?;
            }
        }
        Ok(())
    }
}

async fn forward_frames(mut stream: FrameStream, mut sink: Box<dyn FrameSink>) {
    while let Some(mut frame) = stream.next().await {
        // Keep-latest: drop anything that queued up while we were busy.
        while let Some(Some(newer)) = stream.next().now_or_never() {
            frame = newer;
        }
        if !sink.send(frame) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;

    struct ChannelSink(mpsc::UnboundedSender<Bytes>);

    impl FrameSink for ChannelSink {
        fn send(&mut self, frame: Bytes) -> bool {
            self.0.send(frame).is_ok()
        }
    }

    struct Rig {
        state: Arc<AppState>,
        dir: tempfile::TempDir,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let slots = vec![
            CameraSlot {
                id: CameraId::DEVICE,
                name: "Device Camera",
                preview: PreviewKind::Native,
                provider: Box::new(Unavailable::new(CameraId::DEVICE, "Only on the tablet")),
            },
            CameraSlot {
                id: CameraId::SONY_USB,
                name: "Sony A7 III (USB)",
                preview: PreviewKind::Channel,
                provider: Box::new(Unavailable::new(CameraId::SONY_USB, "Plug the camera in")),
            },
        ];
        let (state, task) = AppState::new(
            dir.path().join("settings.json"),
            slots,
            LogRingBuffer::new(100),
            Timings::default(),
        );
        tokio::spawn(task);
        Rig {
            state: Arc::new(state),
            dir,
        }
    }

    async fn until(
        rx: &mut broadcast::Receiver<SessionState>,
        pred: impl Fn(&SessionState) -> bool,
    ) -> SessionState {
        loop {
            let state = rx.recv().await.expect("session alive");
            if pred(&state) {
                return state;
            }
        }
    }

    fn patch(json: &str) -> SettingsPatch {
        serde_json::from_str(json).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn camera_list_reports_availability_and_the_selection() {
        let rig = rig();
        let list = rig.state.list_cameras().await;
        let summary: Vec<_> = list
            .iter()
            .map(|c| (c.id.as_str().to_owned(), c.available, c.selected))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("device".into(), false, true), // default selection, though unavailable
                ("sony_usb".into(), false, false),
                ("test".into(), true, false),
            ]
        );
        assert_eq!(list[0].reason.as_deref(), Some("Only on the tablet"));
        assert_eq!(list[0].preview, PreviewKind::Native);
        assert_eq!(list[2].reason, None);
        assert_eq!(list[2].status, CameraStatus::Disconnected);
    }

    #[tokio::test(start_paused = true)]
    async fn selecting_an_unavailable_or_unknown_camera_fails_with_the_reason() {
        let rig = rig();
        let err = rig
            .state
            .select_camera(CameraId::SONY_USB)
            .await
            .unwrap_err();
        assert_eq!(err.0, "Plug the camera in");
        let err = rig
            .state
            .select_camera(CameraId::new("vhs"))
            .await
            .unwrap_err();
        assert!(err.0.contains("unknown camera"));
        assert_eq!(rig.state.settings().selected_camera, CameraId::DEVICE);
    }

    #[tokio::test(start_paused = true)]
    async fn selecting_a_camera_persists_the_choice_across_restarts() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        assert_eq!(rig.state.settings().selected_camera, CameraId::TEST);

        let (reloaded, _task) = AppState::new(
            rig.dir.path().join("settings.json"),
            Vec::new(),
            LogRingBuffer::new(10),
            Timings::default(),
        );
        assert_eq!(reloaded.settings().selected_camera, CameraId::TEST);
        assert!(reloaded.list_cameras().await[0].selected);
    }

    #[tokio::test(start_paused = true)]
    async fn camera_cannot_change_mid_session() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        until(&mut events, |s| matches!(s, SessionState::Arming)).await;
        let err = rig.state.select_camera(CameraId::TEST).await.unwrap_err();
        assert!(err.0.contains("current session"), "{err}");
    }

    #[tokio::test(start_paused = true)]
    async fn settings_updates_validate_persist_and_reach_the_mock_camera() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state.connect_camera().await.unwrap();

        let updated = rig
            .state
            .update_settings(patch(
                r#"{"headline":"Ada & Bo","number_of_photos":2,"test_mode":{"capture_delay_ms":1500}}"#,
            ))
            .unwrap();
        assert_eq!(updated.headline, "Ada & Bo");
        assert_eq!(rig.state.settings(), updated);

        let on_disk: Settings =
            serde_json::from_slice(&std::fs::read(rig.dir.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk, updated);

        // The new capture delay is live without a restart.
        let camera = rig.state.active_camera().unwrap();
        let started = tokio::time::Instant::now();
        camera.capture().await.unwrap();
        assert_eq!(started.elapsed(), Duration::from_millis(1500));
    }

    #[tokio::test(start_paused = true)]
    async fn invalid_settings_changes_are_rejected_without_side_effects() {
        let rig = rig();
        let before = rig.state.settings();
        let err = rig
            .state
            .update_settings(patch(r#"{"headline":"x","countdown_seconds":99}"#))
            .unwrap_err();
        assert!(err.0.contains("countdown_seconds"), "{err}");
        assert_eq!(rig.state.settings(), before);
        assert!(!rig.dir.path().join("settings.json").exists());
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_test_mode_session_ends_with_photos_served_then_cleared() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state
            .update_settings(patch(
                r#"{"number_of_photos":2,"countdown_seconds":1,"strip_display_seconds":5}"#,
            ))
            .unwrap();

        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        let strip = until(&mut events, |s| {
            matches!(s, SessionState::StripReview { .. })
        })
        .await;
        let SessionState::StripReview {
            session_id, photos, ..
        } = strip
        else {
            unreachable!()
        };
        assert_eq!(photos, vec![1, 2]);
        for shot in photos {
            let jpeg = rig.state.photos().get(&session_id, shot).expect("stored");
            assert!(jpeg.starts_with(&[0xFF, 0xD8]));
        }

        until(&mut events, |s| matches!(s, SessionState::Attract)).await;
        assert!(
            rig.state.photos().get(&session_id, 1).is_none(),
            "cleared on return home"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn dev_panel_faults_drive_the_session() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        let mut events = rig.state.subscribe_session();

        // A capture failure surfaces as a recoverable error.
        rig.state.inject(Fault::FailNextCapture).await.unwrap();
        rig.state.inject(Fault::StartSession).await.unwrap();
        until(&mut events, |s| matches!(s, SessionState::Countdown { .. })).await;
        rig.state.inject(Fault::SkipCountdown).await.unwrap();
        let err = until(&mut events, |s| matches!(s, SessionState::Error { .. })).await;
        assert!(matches!(
            err,
            SessionState::Error {
                recoverable: true,
                ..
            }
        ));
        rig.state.session_return_home().await.unwrap();
        until(&mut events, |s| matches!(s, SessionState::Attract)).await;

        // A disconnect during the countdown does too.
        rig.state.inject(Fault::StartSession).await.unwrap();
        until(&mut events, |s| matches!(s, SessionState::Countdown { .. })).await;
        rig.state.inject(Fault::DisconnectCamera).await.unwrap();
        until(&mut events, |s| matches!(s, SessionState::Error { .. })).await;
    }

    #[tokio::test(start_paused = true)]
    async fn slow_capture_fault_is_one_shot() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state.connect_camera().await.unwrap();
        rig.state
            .inject(Fault::SlowNextCapture { ms: 4000 })
            .await
            .unwrap();
        let camera = rig.state.active_camera().unwrap();

        let t = tokio::time::Instant::now();
        camera.capture().await.unwrap();
        assert_eq!(t.elapsed(), Duration::from_millis(4000));
        let t = tokio::time::Instant::now();
        camera.capture().await.unwrap();
        assert!(t.elapsed() < Duration::from_millis(1000));
    }

    #[tokio::test(start_paused = true)]
    async fn reset_settings_restores_defaults_but_keeps_the_selected_camera() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state
            .update_settings(patch(r#"{"headline":"Changed","number_of_photos":7}"#))
            .unwrap();
        rig.state.inject(Fault::ResetSettings).await.unwrap();
        let s = rig.state.settings();
        assert_eq!(s.headline, Settings::default().headline);
        assert_eq!(s.number_of_photos, 3);
        assert_eq!(s.selected_camera, CameraId::TEST);
    }

    #[tokio::test(start_paused = true)]
    async fn live_view_forwards_frames_and_stops() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state.connect_camera().await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        rig.state
            .start_live_view(Box::new(ChannelSink(tx)))
            .await
            .unwrap();

        for _ in 0..5 {
            let frame = rx.recv().await.expect("frame");
            assert!(frame.starts_with(&[0xFF, 0xD8]));
        }
        rig.state.stop_live_view().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        while rx.try_recv().is_ok() {} // frames already in flight
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(rx.try_recv().is_err(), "no frames after stop");
    }

    #[tokio::test(start_paused = true)]
    async fn live_view_ends_when_the_consumer_goes_away() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state.connect_camera().await.unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        rig.state
            .start_live_view(Box::new(ChannelSink(tx)))
            .await
            .unwrap();
        drop(rx);
        tokio::time::sleep(Duration::from_secs(1)).await;
        let task = rig.state.live.lock().await.take().expect("forwarder");
        assert!(
            task.is_finished(),
            "forwarder exits once the sink reports closed"
        );
    }

    #[tokio::test]
    async fn forwarder_delivers_only_the_newest_queued_frame() {
        struct Slow(mpsc::UnboundedSender<Bytes>);
        impl FrameSink for Slow {
            fn send(&mut self, frame: Bytes) -> bool {
                self.0.send(frame).is_ok()
            }
        }
        let frames: Vec<Bytes> = (0u8..6).map(|i| Bytes::from(vec![i])).collect();
        let stream: FrameStream = Box::pin(futures_util::stream::iter(frames));
        let (tx, mut rx) = mpsc::unbounded_channel();
        forward_frames(stream, Box::new(Slow(tx))).await;
        let delivered: Vec<Bytes> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        // Everything was already queued, so only the last frame is worth sending.
        assert_eq!(delivered, vec![Bytes::from(vec![5u8])]);
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_and_take_another_are_wired_to_the_session() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        until(&mut events, |s| matches!(s, SessionState::Countdown { .. })).await;
        rig.state.session_cancel().await.unwrap();
        until(&mut events, |s| matches!(s, SessionState::Attract)).await;

        rig.state.session_start();
        until(&mut events, |s| {
            matches!(s, SessionState::StripReview { .. })
        })
        .await;
        rig.state.session_take_another().await.unwrap();
        until(&mut events, |s| matches!(s, SessionState::Arming)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_unavailable_active_camera_makes_a_session_fail_cleanly() {
        let rig = rig(); // default selection is the unavailable device camera
        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        let err = until(&mut events, |s| matches!(s, SessionState::Error { .. })).await;
        assert!(matches!(
            err,
            SessionState::Error {
                recoverable: true,
                ..
            }
        ));
        assert!(rig.state.connect_camera().await.is_err());
    }
}
