//! Error type shared by the transport, the PTP layer and the Sony engine.

use thiserror::Error;

use crate::codes::response_name;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    /// A USB or OS-level failure.
    #[error("USB I/O error: {0}")]
    Io(String),

    /// The camera stalled a USB endpoint (`LIBUSB_ERROR_PIPE`): it rejected a command it
    /// understood but would not carry out. The halt is cleared automatically; the text names
    /// the operation that provoked it.
    #[error("camera stalled the USB pipe ({0})")]
    Stall(String),

    /// A transfer or poll did not complete in time. On a Sony body this very often means the
    /// camera is not in *PC Remote* USB mode.
    #[error("timed out waiting for the camera ({0})")]
    Timeout(&'static str),

    /// The camera answered a PTP operation with a non-OK response code.
    #[error("camera rejected {operation} with {} ({code:#06x})", response_name(*.code))]
    Response { operation: String, code: u16 },

    /// Bytes from the camera did not parse as PTP.
    #[error("malformed PTP data: {0}")]
    Protocol(String),

    /// The device is attached but is not offering the camera's remote-control interface, which
    /// on a Sony body means the USB Connection menu is not set to PC Remote. The text is shown
    /// to the user as is.
    #[error("{0}")]
    WrongUsbMode(String),

    /// No suitable USB device was found.
    #[error("no Sony camera found")]
    NotFound,

    /// An operation needs a connected session.
    #[error("camera is not connected")]
    NotConnected,

    /// A replay transcript did not match what the engine did.
    #[error("replay transcript mismatch: {0}")]
    Replay(String),
}

impl Error {
    pub(crate) fn response(operation: impl Into<String>, code: u16) -> Self {
        Error::Response {
            operation: operation.into(),
            code,
        }
    }

    /// Whether this looks like "the camera is not in PC Remote mode", which deserves a hint.
    pub fn suggests_wrong_usb_mode(&self) -> bool {
        matches!(self, Error::Timeout(_) | Error::WrongUsbMode(_))
    }
}

/// Text appended to errors that probably mean the camera is in the wrong USB mode.
pub const PC_REMOTE_HINT: &str =
    "camera not in PC Remote mode? (set USB Connection to PC Remote and unplug/replug)";
