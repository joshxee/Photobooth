//! Platform-agnostic photobooth domain. No Tauri, no Android, no USB: everything here is
//! plain Rust that runs and is tested on any host.
//!
//! - [`camera`]: the [`Camera`] trait every backend implements.
//! - [`session`]: the attract → countdown → capture → strip flow as a state machine.
//! - [`trigger`]: the seam through which a session is started.
//! - [`gesture`]: open-palm start, built on that seam.
//! - [`settings`]: validated, atomically persisted configuration.
//! - [`photo_store`]: where captured photos live for the UI (in memory).
//! - [`mock`]: the in-memory camera behind "test mode".
//! - [`outbox`]: the portal upload queue, the one place shots touch disk (as variants).

pub mod camera;
pub mod gesture;
pub mod mock;
pub mod outbox;
pub mod photo_store;
pub mod session;
pub mod settings;
pub mod trigger;

pub use camera::{
    Camera, CameraError, CameraId, CameraStatus, CapturedPhoto, FrameStream, JpegFrame,
};
pub use gesture::{
    run_sampler, DetectorError, GestureTrigger, GestureUpdate, PalmDetector, PalmHold, Region,
    DEFAULT_GAP_TOLERANCE, DEFAULT_HOLD,
};
pub use mock::{MockCamera, MockCameraHandle};
pub use photo_store::PhotoStore;
pub use session::{
    CompletedSession, CompletedShot, OnSessionComplete, Session, SessionContext, SessionError,
    SessionHandle, SessionState, SessionTask, Timings,
};
pub use settings::{
    Settings, SettingsError, SettingsPatch, SettingsStore, StartTriggerKind, TestModePatch,
    TestModeSettings,
};
pub use trigger::{DevPanelTrigger, StartTrigger, TapTrigger};
