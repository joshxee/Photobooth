//! `AppState`: everything the commands do, with no dependency on Tauri types so it can be
//! unit tested directly. The commands in `commands.rs` are thin wrappers around these methods.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{FutureExt, StreamExt};
use photobooth_core::{
    run_sampler, Camera, CameraId, CameraStatus, DetectorError, DevPanelTrigger, FrameStream,
    GestureTrigger, GestureUpdate, MockCamera, MockCameraHandle, OnSessionComplete, PalmDetector,
    PhotoStore, Region, Session, SessionContext, SessionHandle, SessionState, SessionTask,
    Settings, SettingsPatch, SettingsStore, StartTrigger, StartTriggerKind, TapTrigger, Timings,
};
#[cfg(any(not(target_os = "android"), test))]
use photobooth_core::{CameraError, CapturedPhoto};
use tokio::sync::{broadcast, watch, Notify};
use tokio::task::JoinHandle;

use crate::dto::{
    CameraInfo, CommandError, Fault, OutboxEntry, OutboxStatus, PortalEvent, PortalStatus,
    PreviewKind,
};
use crate::logs::LogRingBuffer;
use crate::portal::client::PortalOrigin;
use crate::portal::gallery::{is_link_id, PostShoot, SessionShare};
use crate::portal::PortalService;
use crate::upload::hook::{Destination, EncodeAndQueue, Encoder};
use crate::upload::pump::{ClientSource, PortalSource};
use crate::upload::Uploads;

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
    /// Where completed sessions go: the portal outbox, once attached. Unset, nowhere.
    completion_hook: OnceLock<Arc<dyn OnSessionComplete>>,
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

    fn completion_hook(&self) -> Option<Arc<dyn OnSessionComplete>> {
        self.completion_hook.get().cloned()
    }
}

pub struct AppState {
    shared: Arc<Shared>,
    settings_store: SettingsStore,
    photos: PhotoStore,
    session: SessionHandle,
    tap: Arc<TapTrigger>,
    dev: Arc<DevPanelTrigger>,
    gesture: Arc<GestureTrigger>,
    /// The newest live-view frame, for the gesture sampler. Written by whichever forwarder is
    /// running; the sampler reads it at its own pace.
    latest_frame: Arc<watch::Sender<Option<Bytes>>>,
    /// Where the guest's box is in the frame, as last reported by the UI.
    gesture_region: Arc<Mutex<Region>>,
    /// What the UI draws for gesture start; forwarded as `gesture://state`.
    gesture_updates: Arc<watch::Sender<GestureUpdate>>,
    /// A palm put in the box from the developer panel.
    injected_palm: Arc<InjectedPalm>,
    mock: MockCameraHandle,
    live: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    logs: LogRingBuffer,
    portal: Arc<PortalService>,
    /// The portal upload, once attached ([`AppState::attach_uploads`]).
    uploads: OnceLock<Arc<Uploads>>,
    /// Portal changes run one at a time, each with its settings write, so a double tap can't
    /// enrol twice and an unenrol can't interleave with a selection.
    portal_ops: tokio::sync::Mutex<()>,
    /// The selected event's gallery link and the last session handed over, in memory only:
    /// the post-shoot screen's QR code (session 13).
    post_shoot: Arc<PostShoot>,
    /// Wakes the gallery refresher when the enrolment or the event changes.
    gallery_wake: Arc<Notify>,
}

impl AppState {
    /// Builds the state. `platform_slots` are the cameras that depend on the platform (device
    /// camera, Sony USB); the always-available test camera is appended here. The returned
    /// [`SessionTask`] must be spawned on the app's runtime.
    pub fn new(
        settings_path: PathBuf,
        portal: PortalService,
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
            completion_hook: OnceLock::new(),
        });
        let photos = PhotoStore::new();
        let tap = TapTrigger::new();
        let dev = DevPanelTrigger::new();
        let gesture = GestureTrigger::new();
        let gesture_updates = Arc::new(
            watch::channel(GestureUpdate {
                palm: None,
                holding: false,
                hold_ms: gesture.hold_ms(),
            })
            .0,
        );
        let triggers: Vec<Arc<dyn StartTrigger>> = vec![tap.clone(), dev.clone(), gesture.clone()];
        let (session, task) = Session::build(shared.clone(), photos.clone(), timings, triggers);

        (
            Self {
                shared,
                settings_store,
                photos,
                session,
                tap,
                dev,
                gesture,
                latest_frame: Arc::new(watch::channel(None).0),
                gesture_region: Arc::new(Mutex::new(Region::FULL)),
                gesture_updates,
                injected_palm: Arc::new(InjectedPalm::default()),
                mock,
                live: tokio::sync::Mutex::new(None),
                logs,
                portal: Arc::new(portal),
                uploads: OnceLock::new(),
                portal_ops: tokio::sync::Mutex::new(()),
                post_shoot: Arc::new(PostShoot::default()),
                gallery_wake: Arc::new(Notify::new()),
            },
            task,
        )
    }

    /// Sends every completed session (not test mode) to `hook` from now on. Only the first
    /// call counts.
    pub fn set_completion_hook(&self, hook: Arc<dyn OnSessionComplete>) {
        if self.shared.completion_hook.set(hook).is_err() {
            tracing::warn!("a completion hook is already set; keeping the first");
        }
    }

    /// Wires the portal upload in: completed sessions are encoded with `encoder` and queued
    /// to `uploads` while the booth is enrolled and an event is selected, and enrolment
    /// changes reach the upload loop. Only the first call counts. Start the loop itself with
    /// [`AppState::upload_source`].
    pub fn attach_uploads(&self, uploads: Arc<Uploads>, encoder: Encoder) {
        if self.uploads.set(uploads.clone()).is_err() {
            tracing::warn!("uploads are already attached; keeping the first");
            return;
        }
        let destination = Arc::new(AppDestination {
            shared: Arc::downgrade(&self.shared),
            portal: self.portal.clone(),
            post_shoot: self.post_shoot.clone(),
        });
        self.set_completion_hook(EncodeAndQueue::spawn(uploads, destination, encoder));
    }

    /// Where the upload loop gets its client: the stored credential, read before each pass.
    pub fn upload_source(&self) -> Arc<dyn ClientSource> {
        Arc::new(PortalSource::new(self.portal.clone()))
    }

    fn enrolment_changed(&self) {
        if let Some(uploads) = self.uploads.get() {
            uploads.enrolment_changed();
        }
        self.gallery_changed();
    }

    /// The enrolment or the event changed: the gallery link known so far no longer applies.
    fn gallery_changed(&self) {
        self.post_shoot.forget_gallery();
        self.gallery_wake.notify_one();
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
        self.change_settings(|current| {
            *current = Settings {
                // Resetting must not yank the camera the operator is using, nor the portal
                // and event the booth uploads to (those change only through the portal).
                selected_camera: current.selected_camera.clone(),
                portal_url: current.portal_url.clone(),
                selected_event: current.selected_event.clone(),
                ..Settings::default()
            }
        })
    }

    /// Applies `change`, validates and persists the result. Nothing changes if a step fails.
    fn change_settings(
        &self,
        change: impl FnOnce(&mut Settings),
    ) -> Result<Settings, CommandError> {
        let mut guard = lock(&self.shared.settings);
        let mut next = guard.clone();
        change(&mut next);
        self.settings_store.save(&next)?;
        self.mock.set_config(next.test_mode.clone());
        *guard = next.clone();
        Ok(next)
    }

    // ----- portal -----------------------------------------------------------------------

    /// Enrolment and the selected event, for the operator UI. Local only: no network.
    pub fn portal_status(&self) -> PortalStatus {
        let settings = self.settings();
        let (enrolment, problem) = match self.portal.enrolment() {
            Ok(enrolment) => (enrolment, None),
            Err(err) => (None, Some(err.0)),
        };
        let portal_url = match &enrolment {
            Some(e) => e.portal_url.clone(),
            None if !settings.portal_url.is_empty() => settings.portal_url.clone(),
            None => self.portal.config().default_url.clone(),
        };
        PortalStatus {
            enrolled: enrolment.is_some(),
            portal_host: enrolment
                .as_ref()
                .and_then(|e| PortalOrigin::parse(&e.portal_url, true).ok())
                .map(|origin| origin.host()),
            device_name: enrolment.as_ref().map(|e| e.device_name.clone()),
            selected_event: enrolment.and(settings.selected_event),
            portal_url,
            problem,
        }
    }

    /// Enrols with the portal at `url` using a one-time `code`, as `name`.
    pub async fn portal_enrol(
        &self,
        url: &str,
        code: &str,
        name: &str,
    ) -> Result<PortalStatus, CommandError> {
        let _op = self.portal_ops.lock().await;
        let enrolled = self.portal.enrol(url, code, name).await?;
        let saved = self.change_settings(|s| {
            s.portal_url = enrolled.portal_url.clone();
            s.selected_event = None;
        });
        if let Err(err) = saved {
            // Half done is worse than not done: the operator retries with a new code.
            let _ = self.portal.unenrol().await;
            self.enrolment_changed();
            return Err(err);
        }
        self.enrolment_changed();
        Ok(self.portal_status())
    }

    /// Deletes the credential and the event selection. The UI confirms first.
    pub async fn portal_unenrol(&self) -> Result<PortalStatus, CommandError> {
        let _op = self.portal_ops.lock().await;
        let unenrolled = self.portal.unenrol().await;
        self.enrolment_changed();
        unenrolled?;
        self.change_settings(|s| s.selected_event = None)?;
        Ok(self.portal_status())
    }

    pub async fn portal_events(&self) -> Result<Vec<PortalEvent>, CommandError> {
        Ok(self
            .portal
            .events()
            .await?
            .into_iter()
            .map(PortalEvent::from)
            .collect())
    }

    /// Makes event `id` the destination for new photos, if the portal says it is OPEN now.
    /// Photos already queued keep their event (DESIGN §10).
    pub async fn portal_select_event(&self, id: &str) -> Result<PortalStatus, CommandError> {
        let _op = self.portal_ops.lock().await;
        let opened = self.portal.open_event(id).await?;
        let event_id = opened.event.id.clone();
        tracing::info!(
            event_id = %event_id,
            gallery_live = opened.gallery.is_some(),
            "portal event selected"
        );
        self.change_settings(|s| s.selected_event = Some(opened.event))?;
        self.post_shoot.set_gallery(&event_id, opened.gallery);
        Ok(self.portal_status())
    }

    pub async fn portal_clear_event(&self) -> Result<PortalStatus, CommandError> {
        let _op = self.portal_ops.lock().await;
        self.change_settings(|s| s.selected_event = None)?;
        self.gallery_changed();
        tracing::info!("portal event cleared");
        Ok(self.portal_status())
    }

    /// What the review of `session_id` shows the guest: its QR code, a line about the event
    /// gallery, or what the booth showed before the portal (DESIGN §10 item 4). Only the
    /// SVG leaves Rust, never the link or its token.
    pub fn portal_session_qr(&self, session_id: &str) -> SessionShare {
        if !is_link_id(session_id) {
            // Not a session ID: nothing to show, and nothing from the WebView to log.
            return SessionShare::None;
        }
        let share = if matches!(self.portal.enrolment(), Ok(Some(_))) {
            self.post_shoot.share(session_id)
        } else {
            SessionShare::None
        };
        tracing::info!(session_id, mode = share.mode(), "post-shoot screen");
        share
    }

    /// Keeps the selected event's gallery link fresh, in memory only: asks the portal now,
    /// every `every` (5 minutes in the app) and whenever the enrolment or the event changes.
    /// A failed request keeps the last answer. Spawn it on the app's runtime; it ends when
    /// the state is dropped.
    pub fn gallery_refresher(
        &self,
        every: Duration,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let shared = Arc::downgrade(&self.shared);
        let portal = self.portal.clone();
        let post_shoot = self.post_shoot.clone();
        let wake = self.gallery_wake.clone();
        let selected = move || -> Option<Option<String>> {
            let shared = shared.upgrade()?;
            let id = lock(&shared.settings)
                .selected_event
                .as_ref()
                .map(|e| e.id.clone());
            Some(id)
        };
        async move {
            loop {
                let Some(event) = selected() else { return };
                if let Some(event_id) = event {
                    match portal.gallery(&event_id).await {
                        Ok(url) => {
                            let live = url.is_some();
                            let was_live = post_shoot.gallery_for(&event_id).is_some();
                            // Only if the operator didn't change the event meanwhile.
                            let still = || selected().flatten().as_deref() == Some(&*event_id);
                            if post_shoot.set_gallery_if(&event_id, url, still) && live != was_live
                            {
                                tracing::info!(event_id, live, "gallery link updated");
                            }
                        }
                        Err(err) => tracing::info!(
                            event_id,
                            %err,
                            "couldn't refresh the gallery link; keeping the last answer"
                        ),
                    }
                }
                tokio::select! {
                    () = wake.notified() => {}
                    () = tokio::time::sleep(every) => {}
                }
            }
        }
    }

    // ----- upload queue -----------------------------------------------------------------

    /// Counts and flags for the operator's badge. Local only.
    pub fn outbox_status(&self) -> OutboxStatus {
        self.uploads
            .get()
            .map_or_else(OutboxStatus::default, |u| u.status())
    }

    /// The needs-attention list, with reasons. No image bytes.
    pub fn outbox_items(&self) -> Vec<OutboxEntry> {
        self.uploads.get().map_or_else(Vec::new, |u| u.entries())
    }

    /// The upload queue, for `outbox_retry` and `outbox_dismiss` (blocking file I/O, so the
    /// commands run them on a blocking thread). The UI confirms a dismiss first; the SD card
    /// still has the original.
    pub fn uploads(&self) -> Result<Arc<Uploads>, CommandError> {
        self.uploads
            .get()
            .cloned()
            .ok_or_else(|| CommandError::new("The upload queue isn't available on this booth."))
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
        if let Err(err) = camera.connect().await {
            tracing::warn!(camera = %camera.id(), %err, "connect failed");
            return Err(err.into());
        }
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
        let task = tokio::spawn(keep_live_view_running(
            camera,
            stream,
            sink,
            self.latest_frame.clone(),
        ));
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

    // ----- gesture start ----------------------------------------------------------------

    /// The UI reports where the guest's box sits in the camera frame. Until it does, the whole
    /// frame counts.
    pub fn set_gesture_region(&self, region: Region) {
        *lock(&self.gesture_region) = region;
    }

    /// Every gesture update for the UI (the highlight and the hold ring).
    pub fn subscribe_gesture(&self) -> watch::Receiver<GestureUpdate> {
        self.gesture_updates.subscribe()
    }

    /// The open-palm sampler: looks for a palm in the box on the newest live-view frame and
    /// starts a session when one is held. `native` is the platform's recognizer (none on
    /// desktop); a palm put in the box from the developer panel always counts. Spawn it once on
    /// the app's runtime. It looks only while the setting asks for gestures and the booth is
    /// on the attract screen; the tap button works either way.
    pub fn gesture_sampler(
        &self,
        native: Option<Arc<dyn PalmDetector>>,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let shared = self.shared.clone();
        let session = self.session.clone();
        let region = self.gesture_region.clone();
        let mut detectors: Vec<Arc<dyn PalmDetector>> = vec![self.injected_palm.clone()];
        detectors.extend(native);
        run_sampler(
            self.latest_frame.subscribe(),
            Arc::new(FirstPalm(detectors)),
            self.gesture.clone(),
            self.gesture_updates.clone(),
            move || {
                lock(&shared.settings).start_trigger == StartTriggerKind::Gesture
                    && session.state() == SessionState::Attract
            },
            move || *lock(&region),
        )
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
            Fault::HoldPalm { on } => self.injected_palm.set(on),
            Fault::ResetSettings => {
                self.reset_settings()?;
            }
        }
        Ok(())
    }
}

/// The app's answer to "where do completed sessions go": the selected event, while
/// enrolled. Holds the settings weakly: the hook lives inside them.
struct AppDestination {
    shared: Weak<Shared>,
    portal: Arc<PortalService>,
    post_shoot: Arc<PostShoot>,
}

impl Destination for AppDestination {
    fn selected_event(&self) -> Option<String> {
        let shared = self.shared.upgrade()?;
        let event = lock(&shared.settings).selected_event.as_ref()?.id.clone();
        Some(event)
    }

    fn enrolled(&self) -> bool {
        matches!(self.portal.enrolment(), Ok(Some(_)))
    }

    /// Records the session for its QR code; a review with a QR code stays up for the QR
    /// display time.
    fn handed_over(&self, session_id: &str, event_id: &str, shots: usize) -> Option<u8> {
        let qr = self.post_shoot.handed_over(session_id, event_id, shots);
        let shared = self.shared.upgrade()?;
        let seconds = lock(&shared.settings).qr_display_seconds;
        qr.then_some(seconds)
    }
}

/// A palm that the developer panel puts in the box: fills the middle of whatever region it is
/// asked to look in. Lets the whole gesture path be exercised without a hand or a recognizer.
///
/// It lets go by itself after [`INJECTED_PALM_FOR`]: a palm that stayed on after a test left the
/// box green and, because a hand that never leaves cannot start a second session, blocked the
/// next one.
#[derive(Default)]
struct InjectedPalm(Mutex<Option<tokio::time::Instant>>);

/// How long a palm put in the box from the developer panel stays there.
const INJECTED_PALM_FOR: std::time::Duration = std::time::Duration::from_secs(5);

impl InjectedPalm {
    fn set(&self, on: bool) {
        *lock(&self.0) = on.then(|| tokio::time::Instant::now() + INJECTED_PALM_FOR);
    }

    fn present(&self) -> bool {
        lock(&self.0).is_some_and(|until| tokio::time::Instant::now() < until)
    }
}

#[async_trait]
impl PalmDetector for InjectedPalm {
    async fn find_palm(
        &self,
        _jpeg: Bytes,
        within: Region,
    ) -> Result<Option<Region>, DetectorError> {
        Ok(self.present().then(|| Region {
            x: within.x + within.w * 0.25,
            y: within.y + within.h * 0.25,
            w: within.w * 0.5,
            h: within.h * 0.5,
        }))
    }
}

/// Asks each detector in turn and returns the first palm found. A failing detector is skipped
/// while another can still answer.
struct FirstPalm(Vec<Arc<dyn PalmDetector>>);

#[async_trait]
impl PalmDetector for FirstPalm {
    async fn find_palm(
        &self,
        jpeg: Bytes,
        within: Region,
    ) -> Result<Option<Region>, DetectorError> {
        let mut failure = None;
        for detector in &self.0 {
            match detector.find_palm(jpeg.clone(), within).await {
                Ok(Some(palm)) => return Ok(Some(palm)),
                Ok(None) => {}
                Err(err) => failure = Some(err),
            }
        }
        failure.map_or(Ok(None), Err)
    }
}

/// Forwards `stream` to `sink` until the stream ends. `false` means the consumer went away.
async fn forward_frames(
    mut stream: FrameStream,
    sink: &mut dyn FrameSink,
    latest: &watch::Sender<Option<Bytes>>,
) -> bool {
    while let Some(mut frame) = stream.next().await {
        // Keep-latest: drop anything that queued up while we were busy.
        while let Some(Some(newer)) = stream.next().now_or_never() {
            frame = newer;
        }
        latest.send_replace(Some(frame.clone()));
        if !sink.send(frame) {
            return false;
        }
    }
    true
}

/// Forwards live view and, when the camera ends the stream (it failed or was unplugged), resumes
/// into the *same* sink once the camera is back — however it was reconnected (a new session,
/// "Retry connection", ...). Without this the preview froze for good: the stream ended, the
/// camera reconnected, and nothing asked it for frames again.
///
/// Only a camera that left `Ready` and returned counts as back, so a camera whose stream is
/// empty by design (a native preview) is not restarted in a loop.
async fn keep_live_view_running(
    camera: Arc<dyn Camera>,
    first: FrameStream,
    mut sink: Box<dyn FrameSink>,
    latest: Arc<watch::Sender<Option<Bytes>>>,
) {
    let mut status = camera.status();
    let mut stream = first;
    loop {
        if !forward_frames(stream, sink.as_mut(), &latest).await {
            return;
        }
        tracing::info!("live view ended; it resumes when the camera is ready again");
        stream = loop {
            if !wait_until_ready_again(&mut status).await {
                return;
            }
            match camera.start_live_view().await {
                Ok(resumed) => {
                    tracing::info!("live view resumed");
                    break resumed;
                }
                Err(err) => tracing::warn!(%err, "live view could not resume"),
            }
        };
    }
}

/// Waits for the camera to leave `Ready` (it may already have) and become `Ready` again.
/// `false` when the camera is gone for good.
async fn wait_until_ready_again(status: &mut watch::Receiver<CameraStatus>) -> bool {
    while *status.borrow_and_update() == CameraStatus::Ready {
        if status.changed().await.is_err() {
            return false;
        }
    }
    while *status.borrow_and_update() != CameraStatus::Ready {
        if status.changed().await.is_err() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tracing_subscriber::prelude::*;

    use crate::portal::test_server::{Canned, MockPortal};
    use crate::portal::types::tests::fixture;
    use crate::portal::types::DeviceCredential;
    use crate::portal::{CredentialStore, PortalConfig};
    use crate::upload::hook::variant_encoder;
    use std::sync::atomic::{AtomicBool, Ordering};

    const CREDENTIAL_FILE: &str = "portal-credential.json";

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

    fn test_portal(dir: &tempfile::TempDir) -> PortalService {
        PortalService::new(
            CredentialStore::new(dir.path().join(CREDENTIAL_FILE)),
            PortalConfig {
                app_version: "0.4.0".into(),
                allow_lan_http: false,
                default_url: "https://photos.example.invalid".into(),
            },
        )
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
            test_portal(&dir),
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

    struct NoopHook;

    impl OnSessionComplete for NoopHook {
        fn on_session_complete(&self, _: photobooth_core::CompletedSession) -> Option<u8> {
            None
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_completion_hook_reaches_the_session_context_once_set() {
        let rig = rig();
        assert!(rig.state.shared.completion_hook().is_none());
        let hook: Arc<dyn OnSessionComplete> = Arc::new(NoopHook);
        rig.state.set_completion_hook(hook.clone());
        rig.state.set_completion_hook(Arc::new(NoopHook));
        let got = rig.state.shared.completion_hook().expect("hook set");
        assert!(Arc::ptr_eq(&got, &hook), "the first hook is kept");
    }

    // ----- portal ---------------------------------------------------------------------
    // Real time (not `start_paused`): these talk to a local HTTP server.

    const EVENT_ID: &str = "019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01";

    async fn mock_portal() -> MockPortal {
        MockPortal::start(|r| match (r.method.as_str(), r.target.as_str()) {
            ("POST", "/v1/device/enrol") => Canned::fixture("device.enrol-response.valid.json"),
            ("GET", "/v1/device/events") => Canned::fixture("device.events-response.valid.json"),
            _ => Canned::fixture("device.event-detail.live.json"),
        })
        .await
    }

    fn fixture_credential() -> String {
        let response: serde_json::Value =
            serde_json::from_str(fixture("device.enrol-response.valid.json")).unwrap();
        let credential: DeviceCredential =
            serde_json::from_value(response["credential"].clone()).unwrap();
        credential.expose().to_owned()
    }

    #[tokio::test]
    async fn portal_status_before_enrolment_offers_the_default_address() {
        let rig = rig();
        let status = rig.state.portal_status();
        assert!(!status.enrolled);
        assert_eq!(status.portal_url, "https://photos.example.invalid");
        assert_eq!(status.portal_host, None);
        assert_eq!(status.selected_event, None);
        let err = rig.state.portal_select_event(EVENT_ID).await.unwrap_err();
        assert!(err.0.contains("isn't enrolled"), "{err}");
    }

    /// Enrol, list, select: the credential reaches the credential file and the portal, and
    /// nothing else (DESIGN §10; the session's "never in settings, logs or IPC").
    #[tokio::test]
    async fn the_credential_never_reaches_settings_logs_or_ipc() {
        let logs = LogRingBuffer::new(1000);
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(logs.clone())
                .with_ansi(false)
                .with_filter(tracing_subscriber::filter::LevelFilter::TRACE),
        );
        let _guard = tracing::subscriber::set_default(subscriber);

        let rig = rig();
        let portal = mock_portal().await;
        let secret = fixture_credential();

        let mut ipc = Vec::new();
        let enrolled = rig
            .state
            .portal_enrol(&portal.base, "7K3M9Q2Z", "Booth 1")
            .await
            .unwrap();
        assert!(enrolled.enrolled);
        assert_eq!(enrolled.device_name.as_deref(), Some("Booth 1"));
        assert_eq!(
            enrolled.portal_host.as_deref(),
            Some(portal.base.trim_start_matches("http://"))
        );
        ipc.push(serde_json::to_string(&enrolled).unwrap());
        ipc.push(serde_json::to_string(&rig.state.portal_events().await.unwrap()).unwrap());
        ipc.push(
            serde_json::to_string(&rig.state.portal_select_event(EVENT_ID).await.unwrap()).unwrap(),
        );
        ipc.push(serde_json::to_string(&rig.state.portal_status()).unwrap());
        ipc.push(serde_json::to_string(&rig.state.settings()).unwrap());

        for payload in &ipc {
            assert!(
                !payload.contains(&secret),
                "IPC payload leaks it: {payload}"
            );
        }
        let settings_file = std::fs::read_to_string(rig.dir.path().join("settings.json")).unwrap();
        assert!(settings_file.contains(EVENT_ID), "the selection is saved");
        assert!(!settings_file.contains(&secret), "settings JSON leaks it");
        let lines = logs.recent(1000);
        assert!(
            lines.iter().any(|l| l.contains("enrolled with the portal")),
            "logs were captured: {lines:?}"
        );
        for line in &lines {
            assert!(!line.contains(&secret), "log line leaks it: {line}");
        }
        let stored = std::fs::read_to_string(rig.dir.path().join(CREDENTIAL_FILE)).unwrap();
        assert!(stored.contains(&secret), "the credential file holds it");
        // And it was sent as the bearer.
        let sent = portal.requests();
        assert_eq!(
            sent[1].header("authorization"),
            Some(format!("Bearer {secret}").as_str())
        );
    }

    #[tokio::test]
    async fn enrolment_and_selection_are_saved_and_unenrolling_clears_the_event() {
        let rig = rig();
        let portal = mock_portal().await;
        rig.state
            .portal_enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        assert_eq!(rig.state.settings().portal_url, portal.base);
        let status = rig.state.portal_select_event(EVENT_ID).await.unwrap();
        let event = status.selected_event.expect("selected");
        assert_eq!(event.name, "Smith wedding");
        assert_eq!(event.local_date, "2026-10-22");
        assert_eq!(rig.state.settings().selected_event, Some(event.clone()));

        // It survives a restart.
        let (reloaded, _task) = AppState::new(
            rig.dir.path().join("settings.json"),
            test_portal(&rig.dir),
            Vec::new(),
            LogRingBuffer::new(10),
            Timings::default(),
        );
        let status = reloaded.portal_status();
        assert!(status.enrolled);
        assert_eq!(status.selected_event, Some(event));

        let cleared = rig.state.portal_clear_event().await.unwrap();
        assert_eq!(cleared.selected_event, None);
        rig.state.portal_select_event(EVENT_ID).await.unwrap();
        let status = rig.state.portal_unenrol().await.unwrap();
        assert!(!status.enrolled);
        assert_eq!(status.selected_event, None, "no event without an enrolment");
        assert_eq!(
            rig.state.settings().selected_event,
            None,
            "cleared in the settings too, not only hidden by the status"
        );
        assert_eq!(
            status.portal_url, portal.base,
            "kept for the next enrolment"
        );
        assert!(!rig.dir.path().join(CREDENTIAL_FILE).exists());
    }

    #[tokio::test]
    async fn events_reach_the_ui_in_its_own_field_names() {
        let rig = rig();
        let portal = mock_portal().await;
        rig.state
            .portal_enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        let events = rig.state.portal_events().await.unwrap();
        assert_eq!(
            serde_json::to_value(&events[0]).unwrap(),
            serde_json::json!({
                "id": EVENT_ID,
                "name": "Smith wedding",
                "venue": "Morningside Hall",
                "timezone": "Pacific/Auckland",
                "local_date": "2026-10-22",
            })
        );
    }

    #[tokio::test]
    async fn resetting_settings_keeps_the_portal_and_the_event() {
        let rig = rig();
        let portal = mock_portal().await;
        rig.state
            .portal_enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        rig.state.portal_select_event(EVENT_ID).await.unwrap();
        rig.state.inject(Fault::ResetSettings).await.unwrap();
        let settings = rig.state.settings();
        assert_eq!(settings.portal_url, portal.base);
        assert_eq!(
            settings.selected_event.map(|e| e.id),
            Some(EVENT_ID.to_owned())
        );
    }

    #[tokio::test]
    async fn a_damaged_enrolment_is_reported_not_hidden() {
        let rig = rig();
        std::fs::write(rig.dir.path().join(CREDENTIAL_FILE), b"{ damaged").unwrap();
        let status = rig.state.portal_status();
        assert!(!status.enrolled);
        assert!(
            status
                .problem
                .as_deref()
                .is_some_and(|p| p.contains("damaged")),
            "{status:?}"
        );
        // Unenrolling clears it.
        let status = rig.state.portal_unenrol().await.unwrap();
        assert_eq!(status.problem, None);
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
            test_portal(&rig.dir),
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

    /// Unplug (the stream ends), reconnect by any route, and the preview comes back by itself.
    #[tokio::test(start_paused = true)]
    async fn live_view_resumes_into_the_same_sink_after_the_camera_reconnects() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state.connect_camera().await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        rig.state
            .start_live_view(Box::new(ChannelSink(tx)))
            .await
            .unwrap();
        rx.recv().await.expect("frames flow before the fault");

        rig.state.inject(Fault::DisconnectCamera).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        while rx.try_recv().is_ok() {} // frames already in flight
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(rx.try_recv().is_err(), "no frames while the camera is gone");

        // Not through start_live_view: the supervisor must notice the reconnect on its own.
        rig.state.connect_camera().await.unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("frames resume after the reconnect")
            .expect("same sink");
        assert!(frame.starts_with(&[0xFF, 0xD8]));
    }

    #[tokio::test(start_paused = true)]
    async fn live_view_does_not_resume_after_it_was_stopped_on_purpose() {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state.connect_camera().await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        rig.state
            .start_live_view(Box::new(ChannelSink(tx)))
            .await
            .unwrap();
        rx.recv().await.expect("frame");

        rig.state.stop_live_view().await;
        rig.state.inject(Fault::DisconnectCamera).await.unwrap();
        rig.state.connect_camera().await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        while rx.try_recv().is_ok() {}
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(rx.try_recv().is_err(), "a stopped preview stays stopped");
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
        let latest = watch::channel(None).0;
        let consumer_open = forward_frames(stream, &mut Slow(tx), &latest).await;
        assert!(consumer_open);
        let delivered: Vec<Bytes> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        // Everything was already queued, so only the last frame is worth sending.
        assert_eq!(delivered, vec![Bytes::from(vec![5u8])]);
        assert_eq!(
            *latest.borrow(),
            Some(Bytes::from(vec![5u8])),
            "the sampler sees it too"
        );
    }

    /// A rig whose test camera is connected, with the sampler running and live view on.
    async fn gesture_rig(trigger: &str) -> (Rig, mpsc::UnboundedReceiver<Bytes>) {
        let rig = rig();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state
            .update_settings(patch(&format!(r#"{{"start_trigger":"{trigger}"}}"#)))
            .unwrap();
        rig.state.connect_camera().await.unwrap();
        tokio::spawn(rig.state.gesture_sampler(None));
        let (tx, rx) = mpsc::unbounded_channel();
        rig.state
            .start_live_view(Box::new(ChannelSink(tx)))
            .await
            .unwrap();
        (rig, rx)
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_palm_starts_a_session_when_gestures_are_on() {
        let (rig, _frames) = gesture_rig("gesture").await;
        let mut events = rig.state.subscribe_session();
        rig.state
            .inject(Fault::HoldPalm { on: true })
            .await
            .unwrap();
        until(&mut events, |s| matches!(s, SessionState::Arming)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_ui_is_told_about_the_palm_and_the_hold_while_it_is_held() {
        let (rig, _frames) = gesture_rig("gesture").await;
        let mut updates = rig.state.subscribe_gesture();
        rig.state
            .inject(Fault::HoldPalm { on: true })
            .await
            .unwrap();
        loop {
            updates.changed().await.unwrap();
            let update = *updates.borrow_and_update();
            if update.holding {
                let palm = update.palm.expect("the palm is highlighted");
                assert!(Region::FULL.contains(palm.center().0, palm.center().1));
                assert_eq!(update.hold_ms, 1200);
                break;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_box_the_ui_reports_is_where_the_palm_is_looked_for() {
        let (rig, _frames) = gesture_rig("gesture").await;
        let boxed = Region::new(0.5, 0.2, 0.4, 0.6).unwrap();
        rig.state.set_gesture_region(boxed);
        let mut updates = rig.state.subscribe_gesture();
        rig.state
            .inject(Fault::HoldPalm { on: true })
            .await
            .unwrap();
        loop {
            updates.changed().await.unwrap();
            if let Some(palm) = updates.borrow_and_update().palm {
                let (cx, cy) = palm.center();
                assert!(boxed.contains(cx, cy), "{palm:?} should sit in {boxed:?}");
                break;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_palm_put_in_the_box_from_the_dev_panel_lets_go_by_itself() {
        let (rig, _frames) = gesture_rig("gesture").await;
        // A session may well start meanwhile (a held palm does that); only the palm matters here.
        rig.state
            .inject(Fault::HoldPalm { on: true })
            .await
            .unwrap();
        assert!(rig.state.injected_palm.present());
        tokio::time::sleep(INJECTED_PALM_FOR + Duration::from_secs(1)).await;
        assert!(
            !rig.state.injected_palm.present(),
            "it expired without a 'palm away'"
        );
        rig.state
            .inject(Fault::HoldPalm { on: true })
            .await
            .unwrap();
        rig.state
            .inject(Fault::HoldPalm { on: false })
            .await
            .unwrap();
        assert!(
            !rig.state.injected_palm.present(),
            "and 'palm away' still works"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_palm_does_nothing_when_gestures_are_off() {
        let (rig, _frames) = gesture_rig("tap").await;
        rig.state
            .inject(Fault::HoldPalm { on: true })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(rig.state.session_state(), SessionState::Attract);
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

    // ----- uploads (session 10) -------------------------------------------------------
    // Real time: the real HTTP client talks to the local mock portal, and the real encoder
    // runs on its own thread.

    /// The test camera under the Sony's ID: its sessions count as real ones (the session
    /// never hands test-camera sessions over).
    struct AsSony(MockCamera);

    #[async_trait]
    impl Camera for AsSony {
        fn id(&self) -> CameraId {
            CameraId::SONY_USB
        }
        async fn connect(&self) -> Result<(), CameraError> {
            self.0.connect().await
        }
        async fn disconnect(&self) -> Result<(), CameraError> {
            self.0.disconnect().await
        }
        fn status(&self) -> watch::Receiver<CameraStatus> {
            self.0.status()
        }
        async fn start_live_view(&self) -> Result<FrameStream, CameraError> {
            self.0.start_live_view().await
        }
        async fn stop_live_view(&self) -> Result<(), CameraError> {
            self.0.stop_live_view().await
        }
        async fn capture(&self) -> Result<CapturedPhoto, CameraError> {
            self.0.capture().await
        }
    }

    struct UploadRig {
        state: Arc<AppState>,
        uploads: Arc<Uploads>,
        dir: tempfile::TempDir,
        loop_task: tokio::task::JoinHandle<()>,
    }

    impl Drop for UploadRig {
        fn drop(&mut self) {
            self.uploads.shutdown();
            self.loop_task.abort();
        }
    }

    /// Built like `lib.rs` builds the app: the outbox first, the portal service with its
    /// depth, the state, then the hook and the loop.
    fn upload_rig() -> UploadRig {
        let dir = tempfile::tempdir().unwrap();
        let outbox = crate::upload::tests::open_outbox(&dir.path().join("outbox"));
        let uploads = Arc::new(Uploads::new(outbox));
        let depth_of = uploads.clone();
        let portal = test_portal(&dir).with_outbox_depth(Arc::new(move || depth_of.outbox().len()));
        let fast = photobooth_core::TestModeSettings {
            capture_delay_ms: 10,
            ..photobooth_core::TestModeSettings::default()
        };
        let slots = vec![CameraSlot {
            id: CameraId::SONY_USB,
            name: "Sony A7 III (USB)",
            preview: PreviewKind::Channel,
            provider: Box::new(AlwaysAvailable(Arc::new(AsSony(MockCamera::new(fast))))),
        }];
        let (state, task) = AppState::new(
            dir.path().join("settings.json"),
            portal,
            slots,
            LogRingBuffer::new(100),
            Timings {
                tick: Duration::from_millis(20),
                flash: Duration::from_millis(20),
            },
        );
        tokio::spawn(task);
        state.attach_uploads(uploads.clone(), variant_encoder());
        let loop_task = tokio::spawn(crate::upload::pump::run(
            uploads.clone(),
            state.upload_source(),
            Arc::new(std::time::SystemTime::now),
        ));
        UploadRig {
            state: Arc::new(state),
            uploads,
            dir,
            loop_task,
        }
    }

    /// A portal that takes uploads: intents answer PENDING with PUT URLs on itself, a
    /// thumb PUT answers STORED and an HD PUT READY. While `refuse` is set, every upload
    /// call is a 401 (a revoked device).
    async fn upload_portal(refuse: Arc<AtomicBool>) -> MockPortal {
        MockPortal::start(move |r| {
            let refused = refuse.load(Ordering::SeqCst)
                && (r.target == "/v1/device/photos" || r.method == "PUT");
            if refused {
                return Canned::fixture("error.body.unauthorized.json");
            }
            upload_answer(r)
        })
        .await
    }

    /// How the upload portal answers: intents PENDING with PUT URLs on itself, a thumb PUT
    /// STORED, an HD PUT READY, the event detail LIVE.
    fn upload_answer(r: &crate::portal::test_server::Recorded) -> Canned {
        let host = r.header("host").unwrap_or_default().to_owned();
        match (r.method.as_str(), r.target.as_str()) {
            ("POST", "/v1/device/enrol") => Canned::fixture("device.enrol-response.valid.json"),
            ("GET", "/v1/device/events") => Canned::fixture("device.events-response.valid.json"),
            ("GET", _) => Canned::fixture("device.event-detail.live.json"),
            ("POST", "/v1/device/photos") => {
                let id = r.json()["clientPhotoId"].as_str().unwrap().to_owned();
                let target = |variant: &str| {
                    serde_json::json!({
                        "method": "PUT",
                        "url": format!("http://{host}/v1/device/uploads/{id}/{variant}"),
                        "headers": {"Content-Type": "image/jpeg"},
                        "expiresAt": "2026-10-22T09:45:00.000Z",
                    })
                };
                let body = serde_json::json!({
                    "state": "PENDING",
                    "photoId": id,
                    "uploads": {"thumb": target("thumb"), "hd": target("hd")},
                });
                Canned::json(200, &body.to_string())
            }
            ("PUT", t) if t.ends_with("/thumb") => {
                Canned::fixture("device.upload-response.stored.json")
            }
            ("PUT", _) => Canned::fixture("device.upload-response.ready.json"),
            _ => Canned::json(404, "{}"),
        }
    }

    async fn enrol_and_select(rig: &UploadRig, portal: &MockPortal) {
        rig.state
            .portal_enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        rig.state.portal_select_event(EVENT_ID).await.unwrap();
        rig.state.select_camera(CameraId::SONY_USB).await.unwrap();
        rig.state
            .update_settings(patch(
                r#"{"number_of_photos":3,"countdown_seconds":1,"strip_display_seconds":5}"#,
            ))
            .unwrap();
    }

    /// Waits (real time, up to 30 s) until `cond` holds.
    async fn eventually(what: &str, cond: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !cond() {
            assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn intents(portal: &MockPortal) -> Vec<serde_json::Value> {
        portal
            .requests()
            .into_iter()
            .filter(|r| r.target == "/v1/device/photos")
            .map(|r| r.json())
            .collect()
    }

    async fn strip_review(events: &mut broadcast::Receiver<SessionState>) -> String {
        match until(events, |s| matches!(s, SessionState::StripReview { .. })).await {
            SessionState::StripReview { session_id, .. } => session_id,
            _ => unreachable!(),
        }
    }

    /// Capture → encode → queue → intent → both PUTs → READY → deleted, for two sessions,
    /// the second started by "take another" the moment the first reached the review screen.
    #[tokio::test]
    async fn completed_sessions_reach_the_portal_and_leave_nothing_behind() {
        let rig = upload_rig();
        let portal = upload_portal(Arc::new(AtomicBool::new(false))).await;
        enrol_and_select(&rig, &portal).await;

        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        let first = strip_review(&mut events).await;
        rig.state.session_take_another().await.unwrap();
        let second = strip_review(&mut events).await;
        assert_ne!(first, second);

        eventually("six READY photos", || {
            portal
                .requests()
                .iter()
                .filter(|r| r.method == "PUT" && r.target.ends_with("/hd"))
                .count()
                == 6
        })
        .await;
        eventually("an empty outbox", || rig.uploads.outbox().is_empty()).await;
        assert_eq!(
            std::fs::read_dir(rig.dir.path().join("outbox"))
                .unwrap()
                .count(),
            0,
            "every file deleted on READY"
        );

        let sent = intents(&portal);
        assert_eq!(sent.len(), 6, "one intent per shot, no repeats");
        let mut ids: Vec<&str> = sent
            .iter()
            .map(|b| b["clientPhotoId"].as_str().unwrap())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 6, "no duplicate photo IDs");
        for session in [&first, &second] {
            let mut shots: Vec<u64> = sent
                .iter()
                .filter(|b| b["sessionId"] == session.as_str())
                .map(|b| b["shot"].as_u64().unwrap())
                .collect();
            shots.sort_unstable();
            assert_eq!(shots, [1, 2, 3], "session {session}");
        }
        assert!(sent.iter().all(|b| b["eventId"] == EVENT_ID));

        // The bearer and the backlog go with the intent only, never with a PUT.
        let secret = fixture_credential();
        for r in portal.requests() {
            if r.target == "/v1/device/photos" {
                assert_eq!(
                    r.header("authorization"),
                    Some(format!("Bearer {secret}").as_str())
                );
                let depth: usize = r.header("x-outbox-depth").unwrap().parse().unwrap();
                assert!((1..=6).contains(&depth), "depth {depth}");
            }
            if r.method == "PUT" {
                assert_eq!(r.header("authorization"), None);
                assert_eq!(r.header("content-type"), Some("image/jpeg"));
            }
        }
        let status = rig.state.outbox_status();
        assert_eq!(
            (status.queued, status.uploading, status.needs_attention),
            (0, 0, 0)
        );
        assert!(status.available && !status.offline && !status.revoked);
    }

    #[tokio::test]
    async fn cancelled_and_test_mode_sessions_never_reach_the_portal() {
        let rig = upload_rig();
        let portal = upload_portal(Arc::new(AtomicBool::new(false))).await;
        enrol_and_select(&rig, &portal).await;
        let mut events = rig.state.subscribe_session();

        // A guest cancels during the countdown of the second shot.
        rig.state.session_start();
        until(&mut events, |s| {
            matches!(s, SessionState::Countdown { shot: 2, .. })
        })
        .await;
        rig.state.session_cancel().await.unwrap();
        until(&mut events, |s| matches!(s, SessionState::Attract)).await;

        // A whole test-mode session.
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state.session_start();
        strip_review(&mut events).await;

        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(intents(&portal).is_empty());
        assert!(rig.uploads.outbox().is_empty());
        assert!(rig.state.outbox_items().is_empty());
    }

    /// A revoked device: uploads pause with a clear flag, the shots stay queued, and enrolling
    /// again (unenrol, enrol) resumes them.
    #[tokio::test]
    async fn a_revoked_booth_keeps_its_queue_until_it_is_enrolled_again() {
        let rig = upload_rig();
        let refuse = Arc::new(AtomicBool::new(true));
        let portal = upload_portal(refuse.clone()).await;
        enrol_and_select(&rig, &portal).await;

        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        strip_review(&mut events).await;
        eventually("revoked", || rig.state.outbox_status().revoked).await;
        eventually("all three queued", || rig.uploads.outbox().len() == 3).await;
        let status = rig.state.outbox_status();
        assert_eq!(status.needs_attention, 0, "{status:?}");

        refuse.store(false, Ordering::SeqCst);
        rig.state.portal_unenrol().await.unwrap();
        rig.state
            .portal_enrol(&portal.base, "CODE2", "Booth 1")
            .await
            .unwrap();
        eventually("resumed", || rig.uploads.outbox().is_empty()).await;
        assert!(!rig.state.outbox_status().revoked);
    }

    #[test]
    fn without_an_outbox_the_status_says_so_and_commands_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _task) = AppState::new(
            dir.path().join("settings.json"),
            test_portal(&dir),
            Vec::new(),
            LogRingBuffer::new(10),
            Timings::default(),
        );
        assert_eq!(state.outbox_status(), OutboxStatus::default());
        assert!(!state.outbox_status().available);
        assert!(state.outbox_items().is_empty());
        assert!(state.uploads().is_err());
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

    // ----- post-shoot QR code (session 13) ----------------------------------------------

    const TOKEN: &str = "ZXhhbXBsZS10b2tlbi0wMQ";

    /// `upload_portal`, but the event's gallery is LIVE (its link on the mock's own origin)
    /// while `live` is set, and HIDDEN otherwise.
    async fn gallery_portal(live: Arc<AtomicBool>) -> MockPortal {
        MockPortal::start(move |r| {
            if r.method == "GET" && r.target == format!("/v1/device/events/{EVENT_ID}") {
                let host = r.header("host").unwrap();
                let body = if live.load(Ordering::SeqCst) {
                    fixture("device.event-detail.live.json")
                        .replace("https://photos.example.invalid", &format!("http://{host}"))
                } else {
                    fixture("device.event-detail.hidden.json").to_owned()
                };
                return Canned::json(200, &body);
            }
            upload_answer(r)
        })
        .await
    }

    /// The review's session ID and how long it lasts in all.
    async fn review(events: &mut broadcast::Receiver<SessionState>) -> (String, u8) {
        match until(events, |s| matches!(s, SessionState::StripReview { .. })).await {
            SessionState::StripReview {
                session_id,
                auto_return_total,
                ..
            } => (session_id, auto_return_total),
            _ => unreachable!(),
        }
    }

    /// The next review of a session other than `previous` (its countdown may still be queued).
    async fn new_review(
        events: &mut broadcast::Receiver<SessionState>,
        previous: &str,
    ) -> (String, u8) {
        loop {
            let next = review(events).await;
            if next.0 != previous {
                return next;
            }
        }
    }

    /// Selecting a LIVE event caches its link; the next session's review shows the QR code
    /// for exactly that session, for the QR display time. The gallery hidden: no QR code
    /// and the strip display time. The link and its token are never logged or sent as text.
    #[tokio::test]
    async fn a_session_shows_its_qr_code_while_the_gallery_is_live() {
        let logs = LogRingBuffer::new(2000);
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(logs.clone())
                .with_ansi(false)
                .with_filter(tracing_subscriber::filter::LevelFilter::TRACE),
        );
        let _guard = tracing::subscriber::set_default(subscriber);

        let rig = upload_rig();
        let live = Arc::new(AtomicBool::new(true));
        let portal = gallery_portal(live.clone()).await;
        enrol_and_select(&rig, &portal).await;
        rig.state
            .update_settings(patch(r#"{"qr_display_seconds":10}"#))
            .unwrap();
        let refresher = tokio::spawn(rig.state.gallery_refresher(Duration::from_millis(50)));

        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        let (session_id, total) = review(&mut events).await;
        assert_eq!(total, 10, "held for the QR display time");
        let share = rig.state.portal_session_qr(&session_id);
        let SessionShare::Qr { svg } = &share else {
            panic!("expected a QR code, got {share:?}");
        };
        assert_eq!(
            crate::portal::gallery::tests::decode(svg),
            format!(
                "{}/e/k7m2q9x4c3v8b6n5#k={TOKEN}&s={session_id}&n=3",
                portal.base
            )
        );
        assert_eq!(
            rig.state.portal_session_qr("someone-else-1"),
            SessionShare::None,
            "only the session just handed over"
        );
        let ipc = serde_json::to_string(&share).unwrap();
        assert!(
            !ipc.contains(TOKEN),
            "the token never goes over IPC as text"
        );

        // The admin hides the gallery: the refresher notices, and the next review has no QR.
        live.store(false, Ordering::SeqCst);
        eventually("the refresher sees the hidden gallery", || {
            rig.state.post_shoot.gallery_for(EVENT_ID).is_none()
        })
        .await;
        rig.state.session_take_another().await.unwrap();
        let (second, total) = new_review(&mut events, &session_id).await;
        assert_eq!(total, 5, "back to the strip display time");
        assert_eq!(
            rig.state.portal_session_qr(&second),
            SessionShare::EventGallery
        );

        refresher.abort();
        let lines = logs.recent(2000);
        assert!(
            lines.iter().any(|l| l.contains("post-shoot screen")),
            "logs were captured: {lines:?}"
        );
        for line in &lines {
            assert!(!line.contains(TOKEN), "log line leaks the token: {line}");
            assert!(
                !line.contains("/e/k7m2q9x4c3v8b6n5"),
                "log line has the link: {line}"
            );
        }
    }

    /// Not enrolled, no event, or the test camera: the review is as it was before the portal.
    #[tokio::test]
    async fn without_the_portal_the_review_is_unchanged() {
        let rig = upload_rig();
        rig.state.select_camera(CameraId::SONY_USB).await.unwrap();
        rig.state
            .update_settings(patch(
                r#"{"number_of_photos":1,"countdown_seconds":1,"strip_display_seconds":5}"#,
            ))
            .unwrap();
        let mut events = rig.state.subscribe_session();

        // Not enrolled.
        rig.state.session_start();
        let (id, total) = review(&mut events).await;
        assert_eq!(
            (rig.state.portal_session_qr(&id), total),
            (SessionShare::None, 5)
        );

        // Enrolled, no event.
        let portal = gallery_portal(Arc::new(AtomicBool::new(true))).await;
        rig.state
            .portal_enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        rig.state.session_take_another().await.unwrap();
        let (id, total) = new_review(&mut events, &id).await;
        assert_eq!(
            (rig.state.portal_session_qr(&id), total),
            (SessionShare::None, 5)
        );

        // An event with a LIVE gallery, but unenrolled before the guest looks: nothing.
        rig.state.portal_select_event(EVENT_ID).await.unwrap();
        rig.state.session_take_another().await.unwrap();
        let (id, _) = new_review(&mut events, &id).await;
        assert!(matches!(
            rig.state.portal_session_qr(&id),
            SessionShare::Qr { .. }
        ));
        rig.state.portal_unenrol().await.unwrap();
        assert_eq!(rig.state.portal_session_qr(&id), SessionShare::None);
        assert_eq!(
            rig.state.post_shoot.gallery_for(EVENT_ID),
            None,
            "forgotten"
        );
    }

    #[tokio::test]
    async fn the_test_camera_never_gets_a_qr_code() {
        let rig = rig();
        let portal = gallery_portal(Arc::new(AtomicBool::new(true))).await;
        rig.state
            .portal_enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        rig.state.portal_select_event(EVENT_ID).await.unwrap();
        rig.state.select_camera(CameraId::TEST).await.unwrap();
        rig.state
            .update_settings(patch(r#"{"number_of_photos":1,"countdown_seconds":1}"#))
            .unwrap();
        let mut events = rig.state.subscribe_session();
        rig.state.session_start();
        let (id, total) = review(&mut events).await;
        assert_eq!(rig.state.portal_session_qr(&id), SessionShare::None);
        assert_eq!(total, 12, "the strip display time");
    }

    /// Clearing the event forgets its link at once, before any refresh.
    #[tokio::test]
    async fn clearing_the_event_forgets_its_gallery_link() {
        let rig = upload_rig();
        let portal = gallery_portal(Arc::new(AtomicBool::new(true))).await;
        enrol_and_select(&rig, &portal).await;
        assert!(rig.state.post_shoot.gallery_for(EVENT_ID).is_some());
        rig.state.portal_clear_event().await.unwrap();
        assert_eq!(rig.state.post_shoot.gallery_for(EVENT_ID), None);
    }
}
