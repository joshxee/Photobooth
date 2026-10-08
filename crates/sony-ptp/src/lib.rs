//! Wired Sony A7 III support over PTP/USB.
//!
//! The crate is layered so each part is testable without hardware:
//!
//! - [`transport`]: the [`Transport`] byte pipe, plus [`RecordingTransport`] /
//!   [`ReplayTransport`] to capture a real session as a JSON transcript and replay it in
//!   `cargo test`.
//! - [`container`] / [`ptp`]: generic PTP framing and transactions.
//! - [`sony`]: the Sony engine (handshake, shutter, image retrieval, live view).
//! - [`usb`] (feature `rusb-transport` / `desktop-usb`): a libusb [`Transport`], usable on
//!   desktop and, via `RusbTransport::from_handle`, over an Android USB file descriptor.
//! - [`camera`] (feature `core-camera`): `SonyCamera`, an implementation of
//!   `photobooth_core::Camera`.
//! - [`sim`] (feature `sim`, always in tests): a simulated camera for hardware-free tests.

pub mod codes;
pub mod container;
pub mod error;
pub mod jpeg;
pub mod props;
pub mod ptp;
pub mod sony;
pub mod transport;

#[cfg(feature = "rusb-transport")]
pub mod usb;

#[cfg(feature = "core-camera")]
pub mod camera;

#[cfg(any(test, feature = "sim"))]
pub mod sim;

#[cfg(test)]
mod engine_tests;

pub use container::{DeviceInfo, ObjectInfo};
pub use error::{Error, Result};
pub use ptp::{Event, Ptp, Response, Timeouts};
pub use sony::{Capture, Sony, SonyConfig};
pub use transport::{Entry, RecordingTransport, ReplayTransport, Transcript, Transport};

#[cfg(feature = "rusb-transport")]
pub use usb::RusbTransport;

#[cfg(feature = "core-camera")]
pub use camera::SonyCamera;
