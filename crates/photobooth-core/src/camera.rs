//! The camera abstraction every backend (Sony USB, device camera, test mode) implements.

use std::borrow::Cow;
use std::fmt;
use std::pin::Pin;
use std::time::SystemTime;

use async_trait::async_trait;
use bytes::Bytes;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::watch;

/// Identifies a camera backend. A newtype over a string rather than an enum so adding a
/// backend does not require touching every `match` in the app; well-known ids are
/// associated consts.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CameraId(Cow<'static, str>);

impl CameraId {
    /// Sony A7 III over USB (PTP).
    pub const SONY_USB: CameraId = CameraId(Cow::Borrowed("sony_usb"));
    /// The tablet's built-in camera.
    pub const DEVICE: CameraId = CameraId(Cow::Borrowed("device"));
    /// The in-memory test camera.
    pub const TEST: CameraId = CameraId(Cow::Borrowed("test"));

    /// Builds an id from an arbitrary string (e.g. one deserialized from settings).
    pub fn new(id: impl Into<String>) -> Self {
        CameraId(Cow::Owned(id.into()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CameraId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Lifecycle state of a camera, published through [`Camera::status`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "message", rename_all = "snake_case")]
pub enum CameraStatus {
    Disconnected,
    Connecting,
    Ready,
    Busy,
    Error(String),
}

/// Failure modes shared by every camera backend.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum CameraError {
    #[error("camera is not connected")]
    NotConnected,
    #[error("camera is busy")]
    Busy,
    #[error("capture failed: {0}")]
    CaptureFailed(String),
    #[error("camera disconnected")]
    Disconnected,
    #[error("camera protocol error: {0}")]
    Protocol(String),
    #[error("camera I/O error: {0}")]
    Io(String),
}

/// One live-view frame: a complete JPEG.
pub type JpegFrame = Bytes;

/// A stream of live-view frames. Ends when live view stops or the camera disconnects.
pub type FrameStream = Pin<Box<dyn Stream<Item = JpegFrame> + Send>>;

/// A still image taken by [`Camera::capture`].
#[derive(Clone, Debug)]
pub struct CapturedPhoto {
    pub jpeg: Bytes,
    pub width: u32,
    pub height: u32,
    pub taken_at: SystemTime,
}

#[async_trait]
pub trait Camera: Send + Sync {
    fn id(&self) -> CameraId;
    async fn connect(&self) -> Result<(), CameraError>;
    async fn disconnect(&self) -> Result<(), CameraError>;
    /// A receiver that always holds the latest status and wakes on change.
    fn status(&self) -> watch::Receiver<CameraStatus>;
    /// Starts live view. Backends that render their preview natively may return an
    /// empty stream.
    async fn start_live_view(&self) -> Result<FrameStream, CameraError>;
    async fn stop_live_view(&self) -> Result<(), CameraError>;
    async fn capture(&self) -> Result<CapturedPhoto, CameraError>;
}
