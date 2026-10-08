//! The photobooth flow as a state machine driven by a single tokio task (an actor).
//!
//! ```text
//! Attract → Arming → Countdown{shot,remaining} → Capturing{shot} → Flash{shot}
//!     ▲                  ▲                                              │
//!     │                  └────────── more shots to take ────────────────┤
//!     │                                                                 ▼
//!     └──────────────── auto-return / ReturnHome ───────── StripReview{photos,auto_return_in}
//!
//! any active state ── camera error ──► Error{message, recoverable}
//! ```
//!
//! Time comes from `tokio::time`, so tests run the whole flow instantly under
//! `#[tokio::test(start_paused = true)]` instead of sleeping.

use std::future::{pending, Future};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::{sleep_until, Instant};

use crate::camera::{Camera, CameraError, CameraStatus, CapturedPhoto};
use crate::photo_store::PhotoStore;
use crate::settings::Settings;
use crate::trigger::StartTrigger;

/// Observable session state, serialized as `{"state": "snake_case_name", ...fields}`.
///
/// `shot` is 1-based. `total` is the number of photos in the strip so the UI can show
/// "2 of 3" without consulting settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SessionState {
    Attract,
    /// Getting the camera ready (connecting if needed) before the first countdown.
    Arming,
    Countdown {
        shot: u8,
        total: u8,
        remaining: u8,
    },
    Capturing {
        shot: u8,
        total: u8,
    },
    Flash {
        shot: u8,
        total: u8,
    },
    /// `photos` lists the shot numbers available at `booth://photo/<session_id>/<shot>`.
    StripReview {
        session_id: String,
        photos: Vec<u8>,
        auto_return_in: u8,
    },
    Error {
        message: String,
        /// Whether starting again may succeed (true for camera faults).
        recoverable: bool,
    },
}

/// What the session needs from the app: the live settings and the currently selected camera.
/// Both are read at the moment a session starts.
pub trait SessionContext: Send + Sync + 'static {
    fn settings(&self) -> Settings;
    fn camera(&self) -> Option<Arc<dyn Camera>>;
}

/// Real-time durations; tests keep the defaults and let the paused clock fast-forward.
#[derive(Clone, Copy, Debug)]
pub struct Timings {
    /// Length of one countdown / auto-return step.
    pub tick: Duration,
    /// How long the capture flash stays on screen.
    pub flash: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            tick: Duration::from_secs(1),
            flash: Duration::from_millis(300),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum SessionError {
    #[error("session task has stopped")]
    Closed,
}

#[derive(Debug)]
enum Command {
    Start,
    Cancel,
    TakeAnother,
    ReturnHome,
    SkipCountdown,
}

/// Cheap, cloneable control surface for a running session.
#[derive(Clone)]
pub struct SessionHandle {
    commands: mpsc::Sender<Command>,
    state: watch::Receiver<SessionState>,
    events: broadcast::Sender<SessionState>,
}

impl SessionHandle {
    /// The most recently published state.
    pub fn state(&self) -> SessionState {
        self.state.borrow().clone()
    }

    /// Every state change from now on, in order. Subscribe *before* sending a command to
    /// avoid missing its first transition.
    pub fn subscribe(&self) -> broadcast::Receiver<SessionState> {
        self.events.subscribe()
    }

    async fn send(&self, command: Command) -> Result<(), SessionError> {
        self.commands
            .send(command)
            .await
            .map_err(|_| SessionError::Closed)
    }

    /// Starts a session programmatically (equivalent to a trigger firing). Ignored unless the
    /// session is in `Attract` or a recoverable `Error`.
    pub async fn start(&self) -> Result<(), SessionError> {
        self.send(Command::Start).await
    }

    /// Abandons a session in progress and returns to `Attract`, discarding its photos.
    pub async fn cancel(&self) -> Result<(), SessionError> {
        self.send(Command::Cancel).await
    }

    /// From `StripReview`: discards the strip and begins a fresh one.
    pub async fn take_another(&self) -> Result<(), SessionError> {
        self.send(Command::TakeAnother).await
    }

    /// Returns to `Attract` from any state, discarding photos.
    pub async fn return_home(&self) -> Result<(), SessionError> {
        self.send(Command::ReturnHome).await
    }

    /// Developer aid: ends the current countdown immediately and captures.
    pub async fn skip_countdown(&self) -> Result<(), SessionError> {
        self.send(Command::SkipCountdown).await
    }
}

/// The future that drives a session; spawn it on the app's async runtime.
pub type SessionTask = Pin<Box<dyn Future<Output = ()> + Send>>;

pub struct Session;

impl Session {
    /// Builds a session. The returned [`SessionTask`] must be spawned (or awaited) on a tokio
    /// runtime; keeping that choice with the caller lets the app use Tauri's runtime.
    pub fn build(
        ctx: Arc<dyn SessionContext>,
        store: PhotoStore,
        timings: Timings,
        triggers: Vec<Arc<dyn StartTrigger>>,
    ) -> (SessionHandle, SessionTask) {
        let (commands, command_rx) = mpsc::channel(16);
        let (state_tx, state_rx) = watch::channel(SessionState::Attract);
        let (events, _) = broadcast::channel(64);

        let actor = Actor {
            ctx,
            store,
            timings,
            phase: Phase::Attract,
            run: None,
            task: None,
            deadline: None,
            state_tx,
            events: events.clone(),
            nonce: boot_nonce(),
            next_id: 0,
        };
        let forward_tx = commands.clone();
        let task: SessionTask = Box::pin(async move {
            for trigger in triggers {
                spawn_trigger_forwarder(trigger, forward_tx.clone());
            }
            drop(forward_tx);
            actor.run(command_rx).await;
        });

        (
            SessionHandle {
                commands,
                state: state_rx,
                events,
            },
            task,
        )
    }

    /// [`Self::build`] plus `tokio::spawn`; must be called inside a tokio runtime.
    pub fn spawn(
        ctx: Arc<dyn SessionContext>,
        store: PhotoStore,
        timings: Timings,
        triggers: Vec<Arc<dyn StartTrigger>>,
    ) -> SessionHandle {
        let (handle, task) = Self::build(ctx, store, timings, triggers);
        tokio::spawn(task);
        handle
    }
}

fn spawn_trigger_forwarder(trigger: Arc<dyn StartTrigger>, commands: mpsc::Sender<Command>) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = trigger.fired() => {
                    tracing::debug!(trigger = trigger.name(), "start trigger fired");
                    if commands.send(Command::Start).await.is_err() {
                        break;
                    }
                }
                () = commands.closed() => break,
            }
        }
    });
}

/// Distinguishes session ids across app restarts so a cached `booth://` URL from a previous
/// run can never alias a new photo.
fn boot_nonce() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{:x}", millis & 0xFFFF_FFFF)
}

// ---------------------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------------------

/// Where the flow is. Plain data only; the camera and in-flight work live on [`Actor`] so
/// they can be borrowed independently inside `select!`.
enum Phase {
    Attract,
    Arming,
    Countdown { shot: u8, remaining: u8 },
    Capturing { shot: u8 },
    Flash { shot: u8 },
    StripReview { remaining: u8 },
    Error { message: String, recoverable: bool },
}

/// Per-session data, captured from settings when the session starts.
struct Run {
    session_id: String,
    total: u8,
    countdown: u8,
    strip_seconds: u8,
    camera: Arc<dyn Camera>,
    status: Option<watch::Receiver<CameraStatus>>,
}

enum OpOutput {
    Armed(Result<(), CameraError>),
    Captured(Result<CapturedPhoto, CameraError>),
}

enum Event {
    Command(Option<Command>),
    Timer,
    Op(Result<OpOutput, JoinError>),
    /// `true` if the status channel changed, `false` if its sender went away.
    Status(bool),
}

struct Actor {
    ctx: Arc<dyn SessionContext>,
    store: PhotoStore,
    timings: Timings,
    phase: Phase,
    run: Option<Run>,
    /// In-flight arming or capture work.
    task: Option<JoinHandle<OpOutput>>,
    /// When the current phase next advances on its own.
    deadline: Option<Instant>,
    state_tx: watch::Sender<SessionState>,
    events: broadcast::Sender<SessionState>,
    nonce: String,
    next_id: u64,
}

impl Actor {
    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        loop {
            let event = {
                // Disjoint field borrows so each branch future can own its piece of state.
                let Actor {
                    deadline,
                    task,
                    run,
                    ..
                } = &mut self;
                // `select!` evaluates every branch expression even when idle, so each of these
                // must be safe to build with nothing to wait for: they park on `pending()`.
                let timer = async {
                    match *deadline {
                        Some(at) => sleep_until(at).await,
                        None => pending().await,
                    }
                };
                let op = async {
                    match task.as_mut() {
                        Some(handle) => handle.await,
                        None => pending::<Result<OpOutput, JoinError>>().await,
                    }
                };
                let status = async {
                    match run.as_mut().and_then(|r| r.status.as_mut()) {
                        Some(rx) => rx.changed().await.is_ok(),
                        None => pending().await,
                    }
                };
                tokio::select! {
                    biased;
                    command = commands.recv() => Event::Command(command),
                    changed = status => Event::Status(changed),
                    result = op => Event::Op(result),
                    () = timer => Event::Timer,
                }
            };
            if !self.handle(event) {
                break;
            }
        }
        self.abort_task();
        self.store.clear();
    }

    /// Returns `false` when the actor should stop.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Command(None) => return false,
            Event::Command(Some(command)) => self.on_command(command),
            Event::Timer => {
                self.deadline = None;
                self.on_timer();
            }
            Event::Op(result) => {
                self.task = None;
                self.on_op(result);
            }
            Event::Status(changed) => self.on_camera_status(changed),
        }
        true
    }

    // ----- commands ---------------------------------------------------------------------

    fn on_command(&mut self, command: Command) {
        match command {
            Command::Start => {
                if matches!(
                    self.phase,
                    Phase::Attract
                        | Phase::Error {
                            recoverable: true,
                            ..
                        }
                ) {
                    self.begin_run();
                } else {
                    tracing::debug!("start ignored: session already in progress");
                }
            }
            Command::TakeAnother => {
                if matches!(self.phase, Phase::StripReview { .. }) {
                    self.begin_run();
                } else {
                    tracing::debug!("take_another ignored: not reviewing a strip");
                }
            }
            Command::Cancel | Command::ReturnHome => self.go_attract(),
            Command::SkipCountdown => {
                if let Phase::Countdown { shot, .. } = self.phase {
                    self.begin_capture(shot);
                }
            }
        }
    }

    // ----- timers -----------------------------------------------------------------------

    fn on_timer(&mut self) {
        match self.phase {
            Phase::Countdown { shot, remaining } => {
                if remaining > 1 {
                    self.phase = Phase::Countdown {
                        shot,
                        remaining: remaining - 1,
                    };
                    self.deadline = Some(Instant::now() + self.timings.tick);
                    self.publish();
                } else {
                    self.begin_capture(shot);
                }
            }
            Phase::Flash { shot } => {
                let Some(run) = &self.run else { return };
                if shot < run.total {
                    self.phase = Phase::Countdown {
                        shot: shot + 1,
                        remaining: run.countdown,
                    };
                    self.deadline = Some(Instant::now() + self.timings.tick);
                } else {
                    self.phase = Phase::StripReview {
                        remaining: run.strip_seconds,
                    };
                    self.deadline = Some(Instant::now() + self.timings.tick);
                }
                self.publish();
            }
            Phase::StripReview { remaining } => {
                if remaining > 1 {
                    self.phase = Phase::StripReview {
                        remaining: remaining - 1,
                    };
                    self.deadline = Some(Instant::now() + self.timings.tick);
                    self.publish();
                } else {
                    self.go_attract();
                }
            }
            Phase::Attract | Phase::Arming | Phase::Capturing { .. } | Phase::Error { .. } => {}
        }
    }

    // ----- in-flight work ---------------------------------------------------------------

    fn on_op(&mut self, result: Result<OpOutput, JoinError>) {
        let output = match result {
            Ok(output) => output,
            Err(err) => {
                tracing::error!(%err, "camera task failed");
                self.go_error(
                    "Internal error while talking to the camera".to_owned(),
                    false,
                );
                return;
            }
        };
        match (&self.phase, output) {
            (Phase::Arming, OpOutput::Armed(Ok(()))) => {
                let Some(run) = &self.run else { return };
                self.phase = Phase::Countdown {
                    shot: 1,
                    remaining: run.countdown,
                };
                self.deadline = Some(Instant::now() + self.timings.tick);
                self.publish();
            }
            (Phase::Arming, OpOutput::Armed(Err(err))) => self.go_error(err.to_string(), true),
            (&Phase::Capturing { shot }, OpOutput::Captured(Ok(photo))) => {
                let Some(run) = &self.run else { return };
                self.store.put(&run.session_id, shot, photo.jpeg);
                self.phase = Phase::Flash { shot };
                self.deadline = Some(Instant::now() + self.timings.flash);
                self.publish();
            }
            (Phase::Capturing { .. }, OpOutput::Captured(Err(err))) => {
                self.go_error(err.to_string(), true);
            }
            // A result for a phase we have already left (cancelled work that finished first).
            _ => tracing::debug!("discarding stale camera result"),
        }
    }

    fn on_camera_status(&mut self, changed: bool) {
        let Some(run) = self.run.as_mut() else { return };
        let Some(rx) = run.status.as_mut() else {
            return;
        };
        if !changed {
            run.status = None;
            return;
        }
        let status = rx.borrow_and_update().clone();
        let active = matches!(
            self.phase,
            Phase::Arming | Phase::Countdown { .. } | Phase::Capturing { .. } | Phase::Flash { .. }
        );
        if !active {
            return;
        }
        match status {
            CameraStatus::Disconnected => {
                self.go_error(CameraError::Disconnected.to_string(), true);
            }
            CameraStatus::Error(message) => self.go_error(message, true),
            CameraStatus::Connecting | CameraStatus::Ready | CameraStatus::Busy => {}
        }
    }

    // ----- transitions ------------------------------------------------------------------

    fn begin_run(&mut self) {
        self.abort_task();
        self.store.clear();

        let settings = self.ctx.settings();
        let Some(camera) = self.ctx.camera() else {
            self.run = None;
            self.go_error("No camera is selected".to_owned(), false);
            return;
        };

        self.next_id += 1;
        let mut status = camera.status();
        status.borrow_and_update();
        self.run = Some(Run {
            session_id: format!("{}-{}", self.nonce, self.next_id),
            total: settings.number_of_photos,
            countdown: settings.countdown_seconds,
            strip_seconds: settings.strip_display_seconds,
            camera: camera.clone(),
            status: Some(status),
        });

        self.phase = Phase::Arming;
        self.deadline = None;
        self.task = Some(tokio::spawn(async move {
            let ready = matches!(*camera.status().borrow(), CameraStatus::Ready);
            OpOutput::Armed(if ready {
                Ok(())
            } else {
                camera.connect().await
            })
        }));
        self.publish();
    }

    fn begin_capture(&mut self, shot: u8) {
        let Some(run) = &self.run else { return };
        let camera = run.camera.clone();
        self.phase = Phase::Capturing { shot };
        self.deadline = None;
        self.task = Some(tokio::spawn(async move {
            OpOutput::Captured(camera.capture().await)
        }));
        self.publish();
    }

    fn go_attract(&mut self) {
        self.abort_task();
        self.store.clear();
        self.run = None;
        self.deadline = None;
        let changed = !matches!(self.phase, Phase::Attract);
        self.phase = Phase::Attract;
        if changed {
            self.publish();
        }
    }

    /// Photos already taken are kept so a recoverable error does not lose a strip's worth of
    /// work needlessly; they are cleared when the next session starts or on return home.
    fn go_error(&mut self, message: String, recoverable: bool) {
        self.abort_task();
        self.run = None;
        self.deadline = None;
        tracing::warn!(%message, recoverable, "session error");
        self.phase = Phase::Error {
            message,
            recoverable,
        };
        self.publish();
    }

    fn abort_task(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }

    // ----- publishing -------------------------------------------------------------------

    fn current_state(&self) -> SessionState {
        let total = self.run.as_ref().map_or(0, |r| r.total);
        match &self.phase {
            Phase::Attract => SessionState::Attract,
            Phase::Arming => SessionState::Arming,
            Phase::Countdown { shot, remaining } => SessionState::Countdown {
                shot: *shot,
                total,
                remaining: *remaining,
            },
            Phase::Capturing { shot } => SessionState::Capturing { shot: *shot, total },
            Phase::Flash { shot } => SessionState::Flash { shot: *shot, total },
            Phase::StripReview { remaining } => SessionState::StripReview {
                session_id: self
                    .run
                    .as_ref()
                    .map(|r| r.session_id.clone())
                    .unwrap_or_default(),
                photos: (1..=total).collect(),
                auto_return_in: *remaining,
            },
            Phase::Error {
                message,
                recoverable,
            } => SessionState::Error {
                message: message.clone(),
                recoverable: *recoverable,
            },
        }
    }

    fn publish(&self) {
        let state = self.current_state();
        self.state_tx.send_replace(state.clone());
        // No subscribers is normal (e.g. before the UI attaches).
        let _ = self.events.send(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::CameraId;
    use crate::mock::{MockCamera, MockCameraHandle};
    use crate::settings::TestModeSettings;
    use crate::trigger::{DevPanelTrigger, TapTrigger};
    use tokio::sync::broadcast::Receiver;

    struct TestContext {
        settings: Settings,
        camera: Option<Arc<dyn Camera>>,
    }

    impl SessionContext for TestContext {
        fn settings(&self) -> Settings {
            self.settings.clone()
        }
        fn camera(&self) -> Option<Arc<dyn Camera>> {
            self.camera.clone()
        }
    }

    struct Rig {
        handle: SessionHandle,
        events: Receiver<SessionState>,
        camera: MockCameraHandle,
        mock: Arc<MockCamera>,
        store: PhotoStore,
    }

    fn settings(photos: u8, countdown: u8, strip: u8) -> Settings {
        Settings {
            selected_camera: CameraId::TEST,
            number_of_photos: photos,
            countdown_seconds: countdown,
            strip_display_seconds: strip,
            test_mode: TestModeSettings {
                capture_delay_ms: 100,
                ..TestModeSettings::default()
            },
            ..Settings::default()
        }
    }

    fn rig_with(settings: Settings, triggers: Vec<Arc<dyn StartTrigger>>) -> Rig {
        let mock = Arc::new(MockCamera::new(settings.test_mode.clone()));
        let camera = mock.handle();
        let store = PhotoStore::new();
        let ctx = Arc::new(TestContext {
            settings,
            camera: Some(mock.clone() as Arc<dyn Camera>),
        });
        let handle = Session::spawn(ctx, store.clone(), Timings::default(), triggers);
        let events = handle.subscribe();
        Rig {
            handle,
            events,
            camera,
            mock,
            store,
        }
    }

    fn rig(photos: u8, countdown: u8, strip: u8) -> Rig {
        rig_with(settings(photos, countdown, strip), Vec::new())
    }

    async fn next(events: &mut Receiver<SessionState>) -> SessionState {
        events.recv().await.expect("session closed")
    }

    /// Reads states until `pred` matches, returning everything seen including the match.
    async fn until(
        events: &mut Receiver<SessionState>,
        pred: impl Fn(&SessionState) -> bool,
    ) -> Vec<SessionState> {
        let mut seen = Vec::new();
        loop {
            let state = next(events).await;
            let done = pred(&state);
            seen.push(state);
            if done {
                return seen;
            }
        }
    }

    fn countdown(shot: u8, total: u8, remaining: u8) -> SessionState {
        SessionState::Countdown {
            shot,
            total,
            remaining,
        }
    }

    fn is_strip(state: &SessionState) -> bool {
        matches!(state, SessionState::StripReview { .. })
    }

    fn is_countdown(state: &SessionState) -> bool {
        matches!(state, SessionState::Countdown { .. })
    }

    #[tokio::test(start_paused = true)]
    async fn full_session_walks_every_state_in_order() {
        let mut rig = rig(2, 2, 5);
        rig.handle.start().await.unwrap();

        let seen = until(&mut rig.events, |s| matches!(s, SessionState::Attract)).await;
        let session_id = seen
            .iter()
            .find_map(|s| match s {
                SessionState::StripReview { session_id, .. } => Some(session_id.clone()),
                _ => None,
            })
            .expect("strip review reached");

        let review = |n| SessionState::StripReview {
            session_id: session_id.clone(),
            photos: vec![1, 2],
            auto_return_in: n,
        };
        assert_eq!(
            seen,
            vec![
                SessionState::Arming,
                countdown(1, 2, 2),
                countdown(1, 2, 1),
                SessionState::Capturing { shot: 1, total: 2 },
                SessionState::Flash { shot: 1, total: 2 },
                countdown(2, 2, 2),
                countdown(2, 2, 1),
                SessionState::Capturing { shot: 2, total: 2 },
                SessionState::Flash { shot: 2, total: 2 },
                review(5),
                review(4),
                review(3),
                review(2),
                review(1),
                SessionState::Attract,
            ]
        );
        assert_eq!(rig.handle.state(), SessionState::Attract);
    }

    #[tokio::test(start_paused = true)]
    async fn countdown_ticks_once_per_second_and_capture_follows_the_last_tick() {
        let mut rig = rig(1, 3, 5);
        rig.handle.start().await.unwrap();

        until(&mut rig.events, |s| *s == countdown(1, 1, 3)).await;
        let t0 = Instant::now();
        until(&mut rig.events, |s| *s == countdown(1, 1, 2)).await;
        assert_eq!(t0.elapsed(), Duration::from_secs(1));
        until(&mut rig.events, |s| *s == countdown(1, 1, 1)).await;
        assert_eq!(t0.elapsed(), Duration::from_secs(2));
        until(&mut rig.events, |s| {
            matches!(s, SessionState::Capturing { .. })
        })
        .await;
        assert_eq!(t0.elapsed(), Duration::from_secs(3));
    }

    #[tokio::test(start_paused = true)]
    async fn photos_are_stored_while_reviewing_and_cleared_on_auto_return() {
        let mut rig = rig(2, 1, 5);
        rig.handle.start().await.unwrap();

        let seen = until(&mut rig.events, is_strip).await;
        let SessionState::StripReview { session_id, .. } = seen.last().unwrap() else {
            unreachable!()
        };
        assert_eq!(rig.store.len(), 2);
        let first = rig.store.get(session_id, 1).expect("shot 1 stored");
        let second = rig.store.get(session_id, 2).expect("shot 2 stored");
        assert!(first.starts_with(&[0xFF, 0xD8]));
        assert_ne!(first, second, "each shot is a distinct capture");

        until(&mut rig.events, |s| matches!(s, SessionState::Attract)).await;
        assert!(rig.store.is_empty(), "returning to attract clears photos");
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_during_arming_returns_to_attract() {
        let mut rig = rig(3, 3, 5);
        rig.handle.start().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Arming);

        rig.handle.cancel().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Attract);
        // Nothing further happens: the connect that was in flight was abandoned.
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert!(rig.events.try_recv().is_err());
        assert_eq!(rig.handle.state(), SessionState::Attract);
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_mid_countdown_returns_to_attract_and_stops_the_clock() {
        let mut rig = rig(3, 3, 5);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| *s == countdown(1, 3, 2)).await;

        rig.handle.cancel().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Attract);
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert!(
            rig.events.try_recv().is_err(),
            "no stray ticks after cancel"
        );
        assert_eq!(rig.mock.handle().captures_attempted(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_mid_session_discards_photos_already_taken() {
        let mut rig = rig(3, 1, 5);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| *s == countdown(2, 3, 1)).await;
        assert_eq!(rig.store.len(), 1);

        rig.handle.cancel().await.unwrap();
        until(&mut rig.events, |s| matches!(s, SessionState::Attract)).await;
        assert!(rig.store.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_during_a_slow_capture_abandons_it_without_storing_a_photo() {
        let mut rig = rig(1, 1, 5);
        rig.camera.force_slow_next_capture(10_000);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| {
            matches!(s, SessionState::Capturing { .. })
        })
        .await;

        rig.handle.cancel().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Attract);
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert!(rig.events.try_recv().is_err());
        assert!(rig.store.is_empty());
        // Dropping the capture released the camera for the next session.
        assert_eq!(*rig.mock.status().borrow(), CameraStatus::Ready);
    }

    #[tokio::test(start_paused = true)]
    async fn capture_failure_surfaces_a_recoverable_error() {
        let mut rig = rig(3, 1, 5);
        rig.camera.force_fail_next_capture();
        rig.handle.start().await.unwrap();

        let seen = until(&mut rig.events, |s| matches!(s, SessionState::Error { .. })).await;
        match seen.last().unwrap() {
            SessionState::Error {
                message,
                recoverable,
            } => {
                assert!(*recoverable);
                assert!(message.contains("capture failed"), "message: {message}");
            }
            _ => unreachable!(),
        }
        // No further progress on its own.
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(rig.events.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn return_home_leaves_an_error_and_clears_photos() {
        let mut rig = rig(3, 1, 5);
        rig.camera.force_fail_next_capture();
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| matches!(s, SessionState::Error { .. })).await;

        rig.handle.return_home().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Attract);
    }

    #[tokio::test(start_paused = true)]
    async fn start_from_a_recoverable_error_runs_a_fresh_session() {
        let mut rig = rig(1, 1, 5);
        rig.camera.force_fail_next_capture();
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| matches!(s, SessionState::Error { .. })).await;

        rig.handle.start().await.unwrap();
        let seen = until(&mut rig.events, is_strip).await;
        assert_eq!(seen[0], SessionState::Arming);
    }

    #[tokio::test(start_paused = true)]
    async fn camera_disconnect_mid_countdown_becomes_a_recoverable_error() {
        let mut rig = rig(3, 3, 5);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| *s == countdown(1, 3, 2)).await;

        rig.camera.force_disconnect();
        let state = next(&mut rig.events).await;
        assert_eq!(
            state,
            SessionState::Error {
                message: CameraError::Disconnected.to_string(),
                recoverable: true,
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn recovering_from_a_disconnect_reconnects_on_the_next_start() {
        let mut rig = rig(1, 1, 5);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| *s == countdown(1, 1, 1)).await;
        rig.camera.force_disconnect();
        until(&mut rig.events, |s| matches!(s, SessionState::Error { .. })).await;

        rig.handle.start().await.unwrap();
        until(&mut rig.events, is_strip).await;
    }

    #[tokio::test(start_paused = true)]
    async fn take_another_discards_the_strip_and_starts_a_new_session() {
        let mut rig = rig(1, 1, 30);
        rig.handle.start().await.unwrap();
        let first = until(&mut rig.events, is_strip).await;
        let SessionState::StripReview {
            session_id: first_id,
            ..
        } = first.last().unwrap().clone()
        else {
            unreachable!()
        };
        assert!(rig.store.get(&first_id, 1).is_some());

        rig.handle.take_another().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Arming);
        assert!(rig.store.get(&first_id, 1).is_none(), "old strip discarded");

        let second = until(&mut rig.events, is_strip).await;
        let SessionState::StripReview {
            session_id: second_id,
            ..
        } = second.last().unwrap().clone()
        else {
            unreachable!()
        };
        assert_ne!(first_id, second_id, "a new strip gets a new session id");
        assert!(rig.store.get(&second_id, 1).is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn take_another_is_ignored_outside_strip_review() {
        let mut rig = rig(3, 3, 5);
        rig.handle.take_another().await.unwrap();
        rig.handle.start().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Arming);
        until(&mut rig.events, is_countdown).await;
        rig.handle.take_another().await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(matches!(
            rig.handle.state(),
            SessionState::Countdown { shot: 1, .. }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn start_is_ignored_while_a_session_is_running() {
        let mut rig = rig(3, 3, 5);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| *s == countdown(1, 3, 3)).await;
        rig.handle.start().await.unwrap();
        // The next state is the normal tick, not a restart through Arming.
        assert_eq!(next(&mut rig.events).await, countdown(1, 3, 2));
    }

    #[tokio::test(start_paused = true)]
    async fn return_home_from_strip_review_goes_straight_to_attract() {
        let mut rig = rig(1, 1, 30);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, is_strip).await;
        rig.handle.return_home().await.unwrap();
        assert_eq!(next(&mut rig.events).await, SessionState::Attract);
        assert!(rig.store.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn skip_countdown_captures_immediately() {
        let mut rig = rig(1, 10, 5);
        rig.handle.start().await.unwrap();
        until(&mut rig.events, |s| *s == countdown(1, 1, 10)).await;
        let t0 = Instant::now();
        rig.handle.skip_countdown().await.unwrap();
        assert_eq!(
            next(&mut rig.events).await,
            SessionState::Capturing { shot: 1, total: 1 }
        );
        assert_eq!(t0.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn no_selected_camera_is_an_unrecoverable_error() {
        let ctx = Arc::new(TestContext {
            settings: settings(1, 1, 5),
            camera: None,
        });
        let handle = Session::spawn(ctx, PhotoStore::new(), Timings::default(), Vec::new());
        let mut events = handle.subscribe();
        handle.start().await.unwrap();
        assert_eq!(
            next(&mut events).await,
            SessionState::Error {
                message: "No camera is selected".to_owned(),
                recoverable: false,
            }
        );
        // Not restartable until a camera exists: Start is ignored, home works.
        handle.start().await.unwrap();
        handle.return_home().await.unwrap();
        assert_eq!(next(&mut events).await, SessionState::Attract);
    }

    #[tokio::test(start_paused = true)]
    async fn settings_are_read_when_each_session_starts() {
        struct Live(std::sync::Mutex<Settings>, Arc<MockCamera>);
        impl SessionContext for Live {
            fn settings(&self) -> Settings {
                self.0.lock().unwrap().clone()
            }
            fn camera(&self) -> Option<Arc<dyn Camera>> {
                Some(self.1.clone() as Arc<dyn Camera>)
            }
        }
        let mock = Arc::new(MockCamera::new(TestModeSettings::default()));
        let ctx = Arc::new(Live(std::sync::Mutex::new(settings(1, 1, 5)), mock));
        let handle = Session::spawn(
            ctx.clone(),
            PhotoStore::new(),
            Timings::default(),
            Vec::new(),
        );
        let mut events = handle.subscribe();

        handle.start().await.unwrap();
        let first = until(&mut events, |s| matches!(s, SessionState::Attract)).await;
        assert!(first.contains(&countdown(1, 1, 1)));

        *ctx.0.lock().unwrap() = settings(2, 2, 5);
        handle.start().await.unwrap();
        let second = until(&mut events, |s| matches!(s, SessionState::Attract)).await;
        assert!(
            second.contains(&countdown(2, 2, 2)),
            "uses the new settings"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn registered_triggers_start_a_session_from_attract() {
        let tap = TapTrigger::new();
        let dev = DevPanelTrigger::new();
        let mut rig = rig_with(
            settings(1, 1, 5),
            vec![tap.clone() as Arc<dyn StartTrigger>, dev.clone()],
        );

        tap.fire();
        assert_eq!(next(&mut rig.events).await, SessionState::Arming);
        until(&mut rig.events, |s| matches!(s, SessionState::Attract)).await;

        dev.fire();
        assert_eq!(next(&mut rig.events).await, SessionState::Arming);
    }

    #[tokio::test(start_paused = true)]
    async fn triggers_firing_mid_session_do_not_restart_it() {
        let tap = TapTrigger::new();
        let mut rig = rig_with(
            settings(1, 3, 5),
            vec![tap.clone() as Arc<dyn StartTrigger>],
        );
        tap.fire();
        until(&mut rig.events, |s| *s == countdown(1, 1, 3)).await;
        tap.fire();
        assert_eq!(next(&mut rig.events).await, countdown(1, 1, 2));
    }

    #[test]
    fn state_json_is_tagged_snake_case() {
        let json = |s: &SessionState| serde_json::to_value(s).unwrap();
        assert_eq!(
            json(&SessionState::Attract),
            serde_json::json!({"state": "attract"})
        );
        assert_eq!(
            json(&countdown(2, 3, 1)),
            serde_json::json!({"state": "countdown", "shot": 2, "total": 3, "remaining": 1})
        );
        assert_eq!(
            json(&SessionState::StripReview {
                session_id: "abc-1".into(),
                photos: vec![1, 2, 3],
                auto_return_in: 12,
            }),
            serde_json::json!({
                "state": "strip_review",
                "session_id": "abc-1",
                "photos": [1, 2, 3],
                "auto_return_in": 12
            })
        );
        assert_eq!(
            json(&SessionState::Error {
                message: "boom".into(),
                recoverable: true
            }),
            serde_json::json!({"state": "error", "message": "boom", "recoverable": true})
        );
        let round: SessionState =
            serde_json::from_value(json(&SessionState::Flash { shot: 1, total: 3 })).unwrap();
        assert_eq!(round, SessionState::Flash { shot: 1, total: 3 });
    }
}
