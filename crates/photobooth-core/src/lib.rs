//! Platform-agnostic photobooth domain. No Tauri, no Android, no USB: everything here is
//! plain Rust that runs and is tested on any host.
//!
//! - [`camera`]: the [`Camera`] trait every backend implements.
//! - [`session`]: the attract → countdown → capture → strip flow as a state machine.
//! - [`trigger`]: the seam through which a session is started.
//! - [`settings`]: validated, atomically persisted configuration.
//! - [`photo_store`]: the only place captured photos live (in memory).
//! - [`mock`]: the in-memory camera behind "test mode".

pub mod camera;
pub mod mock;
pub mod photo_store;
pub mod session;
pub mod settings;
pub mod trigger;

pub use camera::{
    Camera, CameraError, CameraId, CameraStatus, CapturedPhoto, FrameStream, JpegFrame,
};
pub use mock::{MockCamera, MockCameraHandle};
pub use photo_store::PhotoStore;
pub use session::{
    Session, SessionContext, SessionError, SessionHandle, SessionState, SessionTask, Timings,
};
pub use settings::{
    Settings, SettingsError, SettingsPatch, SettingsStore, StartTriggerKind, TestModePatch,
    TestModeSettings,
};
pub use trigger::{DevPanelTrigger, StartTrigger, TapTrigger};
