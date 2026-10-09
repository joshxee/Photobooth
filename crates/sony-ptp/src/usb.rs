//! A libusb [`Transport`] built on `rusb`.
//!
//! On desktop, [`RusbTransport::open_first_sony`] finds the camera by vendor id. On Android
//! the app has no permission to enumerate devices through libusb; instead Kotlin opens the
//! device with `UsbManager`, hands Rust a file descriptor, and the plugin builds a
//! `DeviceHandle` with `open_device_with_fd` and passes it to [`RusbTransport::from_handle`].

use std::time::Duration;

use rusb::{Direction, TransferType, UsbContext};

use crate::codes::{SONY_VENDOR_ID, USB_CLASS_STILL_IMAGE};
use crate::error::{Error, Result};
use crate::transport::Transport;

pub struct RusbTransport<C: UsbContext> {
    handle: rusb::DeviceHandle<C>,
    interface: u8,
    ep_in: u8,
    ep_out: u8,
    ep_interrupt: u8,
}

fn io(err: rusb::Error) -> Error {
    Error::Io(err.to_string())
}

impl<C: UsbContext> RusbTransport<C> {
    /// Wraps an already-open device: locates the still-image (PTP) interface and its three
    /// endpoints, then claims it.
    pub fn from_handle(handle: rusb::DeviceHandle<C>) -> Result<Self> {
        let config = handle.device().active_config_descriptor().map_err(io)?;
        for interface in config.interfaces() {
            for descriptor in interface.descriptors() {
                if descriptor.class_code() != USB_CLASS_STILL_IMAGE {
                    continue;
                }
                let mut ep_in = None;
                let mut ep_out = None;
                let mut ep_interrupt = None;
                for endpoint in descriptor.endpoint_descriptors() {
                    match (endpoint.transfer_type(), endpoint.direction()) {
                        (TransferType::Bulk, Direction::In) => ep_in = Some(endpoint.address()),
                        (TransferType::Bulk, Direction::Out) => ep_out = Some(endpoint.address()),
                        (TransferType::Interrupt, Direction::In) => {
                            ep_interrupt = Some(endpoint.address());
                        }
                        _ => {}
                    }
                }
                if let (Some(ep_in), Some(ep_out), Some(ep_interrupt)) =
                    (ep_in, ep_out, ep_interrupt)
                {
                    let number = descriptor.interface_number();
                    // Not supported on every platform (e.g. Windows, Android fds); harmless.
                    let _ = handle.set_auto_detach_kernel_driver(true);
                    handle.claim_interface(number).map_err(io)?;
                    return Ok(Self {
                        handle,
                        interface: number,
                        ep_in,
                        ep_out,
                        ep_interrupt,
                    });
                }
            }
        }
        Err(Error::Protocol(
            "USB device has no still-image interface with bulk in/out and interrupt endpoints; \
             is the camera in PC Remote mode?"
                .to_owned(),
        ))
    }

    fn map(err: rusb::Error, what: &'static str) -> Error {
        match err {
            rusb::Error::Timeout => Error::Timeout(what),
            rusb::Error::Pipe => Error::Stall(what.to_owned()),
            other => io(other),
        }
    }
}

impl RusbTransport<rusb::Context> {
    /// Opens the first attached Sony still-image device.
    pub fn open_first_sony() -> Result<Self> {
        let context = rusb::Context::new().map_err(io)?;
        for device in context.devices().map_err(io)?.iter() {
            let Ok(descriptor) = device.device_descriptor() else {
                continue;
            };
            if descriptor.vendor_id() != SONY_VENDOR_ID {
                continue;
            }
            let handle = device.open().map_err(io)?;
            match Self::from_handle(handle) {
                Ok(transport) => return Ok(transport),
                Err(e) => tracing::debug!(%e, "Sony USB device is not a PTP camera; skipping"),
            }
        }
        Err(Error::NotFound)
    }
}

impl<C: UsbContext> Transport for RusbTransport<C> {
    fn write_bulk(&mut self, buf: &[u8], timeout: Duration) -> Result<usize> {
        self.handle
            .write_bulk(self.ep_out, buf, timeout)
            .map_err(|e| Self::map(e, "bulk write"))
    }

    fn read_bulk(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        self.handle
            .read_bulk(self.ep_in, buf, timeout)
            .map_err(|e| Self::map(e, "bulk read"))
    }

    fn read_interrupt(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        self.handle
            .read_interrupt(self.ep_interrupt, buf, timeout)
            .map_err(|e| Self::map(e, "interrupt read"))
    }

    /// Clears a stalled bulk pipe rather than resetting the whole device: a full USB reset
    /// would invalidate the permission-bearing file descriptor on Android.
    fn reset(&mut self) -> Result<()> {
        self.handle.clear_halt(self.ep_in).map_err(io)?;
        self.handle.clear_halt(self.ep_out).map_err(io)
    }
}

impl<C: UsbContext> Drop for RusbTransport<C> {
    fn drop(&mut self) {
        let _ = self.handle.release_interface(self.interface);
    }
}
