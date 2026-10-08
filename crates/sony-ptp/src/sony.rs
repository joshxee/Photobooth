//! The Sony A7 III engine: handshake, shooting, image retrieval and live view on top of the
//! generic PTP layer.
//!
//! Everything blocking: it is driven from a dedicated thread (`spawn_blocking`) by
//! `SonyCamera`, or directly from the `shoot` example.

use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::codes::{button, event, format, handle, op, prop, rc, OBJECT_IN_MEMORY_READY};
use crate::container::{DeviceInfo, ObjectInfo};
use crate::error::{Error, Result};
use crate::jpeg;
use crate::props;
use crate::ptp::{Ptp, Timeouts};
use crate::transport::Transport;

/// Tunables. `Default` is for real hardware; [`SonyConfig::no_delays`] is for tests.
#[derive(Clone, Debug)]
pub struct SonyConfig {
    pub timeouts: Timeouts,
    /// How many times to retry `SDIO_GetExtDeviceInfo` while it returns nothing.
    pub handshake_retries: u32,
    pub handshake_retry_delay: Duration,
    /// Pause between half-press (autofocus) and full press.
    pub af_settle: Duration,
    /// How long to wait for the captured image to appear in camera memory.
    pub image_timeout: Duration,
    /// Interval between checks for the image; also the interrupt-pipe read timeout.
    pub poll_interval: Duration,
    /// How long to wait for live view to become active.
    pub live_view_timeout: Duration,
    /// Objects larger than this are fetched in chunks with `SDIO_GetPartialLargeObject`.
    ///
    /// **Off by default** (`u32::MAX`). Measured on a real A7 III: for a 10.4 MB JPEG the camera
    /// *stalls the USB pipe* on `SDIO_GetPartialLargeObject(handle, 0, 0, 1 MiB)`, while a plain
    /// `GetObject` of the handle is the standard way and is what is used instead. The chunked
    /// path is kept (and tested) for bodies that need it, but must be opted into.
    pub chunk_threshold: u32,
    pub chunk_size: u32,
    /// Upper bound on objects consumed while looking for the JPEG (skips RAW companions).
    pub max_objects_per_capture: u32,
}

impl Default for SonyConfig {
    fn default() -> Self {
        Self {
            timeouts: Timeouts::default(),
            handshake_retries: 20,
            handshake_retry_delay: Duration::from_millis(100),
            af_settle: Duration::from_millis(300),
            image_timeout: Duration::from_secs(10),
            poll_interval: Duration::from_millis(50),
            live_view_timeout: Duration::from_secs(3),
            chunk_threshold: u32::MAX,
            chunk_size: 1024 * 1024,
            max_objects_per_capture: 4,
        }
    }
}

impl SonyConfig {
    /// No sleeps and short timeouts, for simulated cameras and replay.
    pub fn no_delays() -> Self {
        Self {
            timeouts: Timeouts {
                command: Duration::from_millis(50),
                data: Duration::from_millis(50),
            },
            handshake_retry_delay: Duration::ZERO,
            af_settle: Duration::ZERO,
            image_timeout: Duration::from_millis(200),
            poll_interval: Duration::from_millis(1),
            live_view_timeout: Duration::from_millis(50),
            ..Self::default()
        }
    }
}

/// A finished capture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub filename: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PropMode {
    Unknown,
    ExtInfo,
    Standard,
}

pub struct Sony<T: Transport> {
    ptp: Ptp<T>,
    cfg: SonyConfig,
    info: Option<DeviceInfo>,
    connected: bool,
    prop_mode: PropMode,
}

/// Holds the shutter buttons and guarantees they are released — **S2 before S1** — even on an
/// early return or a panic, so a failure can never leave the shutter held (which in a
/// continuous drive mode would keep the camera firing).
struct ShutterGuard<'a, T: Transport> {
    ptp: &'a mut Ptp<T>,
    s1_down: bool,
    s2_down: bool,
}

impl<'a, T: Transport> ShutterGuard<'a, T> {
    fn new(ptp: &'a mut Ptp<T>) -> Self {
        Self {
            ptp,
            s1_down: false,
            s2_down: false,
        }
    }

    // The flags are set *before* the command is sent: if the write fails after the camera has
    // acted on it, we must still try to release.
    fn half_press(&mut self) -> Result<()> {
        self.s1_down = true;
        control(self.ptp, prop::SHUTTER_HALF, button::DOWN)
    }

    fn full_press(&mut self) -> Result<()> {
        self.s2_down = true;
        control(self.ptp, prop::SHUTTER_FULL, button::DOWN)
    }

    /// Releases whatever is held, S2 first. Attempts both releases even if the first fails and
    /// returns the first error.
    fn release(&mut self) -> Result<()> {
        let mut first_error = None;
        if self.s2_down {
            self.s2_down = false;
            if let Err(e) = control(self.ptp, prop::SHUTTER_FULL, button::UP) {
                first_error = Some(e);
            }
        }
        if self.s1_down {
            self.s1_down = false;
            if let Err(e) = control(self.ptp, prop::SHUTTER_HALF, button::UP) {
                first_error.get_or_insert(e);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl<T: Transport> Drop for ShutterGuard<'_, T> {
    fn drop(&mut self) {
        if self.s1_down || self.s2_down {
            if let Err(err) = self.release() {
                tracing::warn!(%err, "could not release the shutter while unwinding");
            }
        }
    }
}

fn control<T: Transport>(ptp: &mut Ptp<T>, code: u16, value: u16) -> Result<()> {
    ptp.call(
        op::SDIO_CONTROL_DEVICE,
        &[u32::from(code)],
        Some(&value.to_le_bytes()),
    )
    .map(|_| ())
}

impl<T: Transport> Sony<T> {
    pub fn new(transport: T, cfg: SonyConfig) -> Self {
        Self {
            ptp: Ptp::new(transport, cfg.timeouts),
            cfg,
            info: None,
            connected: false,
            prop_mode: PropMode::Unknown,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn device_info(&self) -> Option<&DeviceInfo> {
        self.info.as_ref()
    }

    pub fn ptp(&self) -> &Ptp<T> {
        &self.ptp
    }

    pub fn ptp_mut(&mut self) -> &mut Ptp<T> {
        &mut self.ptp
    }

    pub fn into_transport(self) -> T {
        self.ptp.into_transport()
    }

    // ----- connection -------------------------------------------------------------------

    /// `GetDeviceInfo` → `OpenSession(1)` → `SDIO_Connect(1)` → `SDIO_Connect(2)` →
    /// `SDIO_GetExtDeviceInfo` (retried while empty) → `SDIO_Connect(3)`.
    pub fn connect(&mut self) -> Result<&DeviceInfo> {
        self.connected = false;
        self.prop_mode = PropMode::Unknown;

        let info = DeviceInfo::parse(&self.ptp.call(op::GET_DEVICE_INFO, &[], None)?.data)?;
        tracing::info!(model = %info.model, version = %info.device_version, "camera found");
        if !info.supports(op::SDIO_CONNECT) {
            return Err(Error::Protocol(format!(
                "{} does not offer Sony's remote-control operations; set USB Connection to PC Remote",
                if info.model.is_empty() { "camera" } else { &info.model }
            )));
        }

        self.ptp.open_session(1)?;
        self.sdio_connect(1)?;
        self.sdio_connect(2)?;
        self.wait_for_ext_device_info()?;
        self.sdio_connect(3)?;

        self.connected = true;
        Ok(self.info.insert(info))
    }

    fn sdio_connect(&mut self, phase: u32) -> Result<()> {
        self.ptp.call(op::SDIO_CONNECT, &[phase, 0, 0], None)?;
        Ok(())
    }

    /// An empty answer is normal while the camera finishes bringing up the remote interface.
    fn wait_for_ext_device_info(&mut self) -> Result<()> {
        for attempt in 0..=self.cfg.handshake_retries {
            let response = self
                .ptp
                .transaction(op::SDIO_GET_EXT_DEVICE_INFO, &[0xC8], None)?;
            match response.code {
                rc::OK if !response.data.is_empty() => return Ok(()),
                rc::OK | rc::DEVICE_BUSY => {
                    tracing::debug!(attempt, "extended device info not ready yet");
                    sleep(self.cfg.handshake_retry_delay);
                }
                code => {
                    return Err(Error::response("SDIO_GetExtDeviceInfo", code));
                }
            }
        }
        Err(Error::Timeout("camera never reported extended device info"))
    }

    /// Closes the session. The transport stays usable for a later `connect`.
    pub fn disconnect(&mut self) -> Result<()> {
        self.connected = false;
        self.ptp.close_session()
    }

    fn require_connected(&self) -> Result<()> {
        if self.connected {
            Ok(())
        } else {
            Err(Error::NotConnected)
        }
    }

    // ----- properties -------------------------------------------------------------------

    /// Reads a 16-bit Sony property. Tries the dataset call libgphoto2 uses, then the generic
    /// `GetDevicePropValue`, and remembers which worked.
    pub fn property_u16(&mut self, code: u16) -> Result<u16> {
        match self.prop_mode {
            PropMode::ExtInfo => self.prop_via_ext_info(code),
            PropMode::Standard => self.prop_via_standard(code),
            PropMode::Unknown => match self.prop_via_ext_info(code) {
                Ok(v) => {
                    self.prop_mode = PropMode::ExtInfo;
                    Ok(v)
                }
                // A timeout means the pipe is stuck, not that the op is unsupported.
                Err(e @ Error::Timeout(_)) => Err(e),
                Err(first) => match self.prop_via_standard(code) {
                    Ok(v) => {
                        tracing::info!("property reads work via GetDevicePropValue");
                        self.prop_mode = PropMode::Standard;
                        Ok(v)
                    }
                    Err(_) => Err(first),
                },
            },
        }
    }

    fn prop_via_ext_info(&mut self, code: u16) -> Result<u16> {
        let response = self
            .ptp
            .call(op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO, &[], None)?;
        props::current_u16(&response.data, code)
    }

    fn prop_via_standard(&mut self, code: u16) -> Result<u16> {
        let response = self
            .ptp
            .call(op::GET_DEVICE_PROP_VALUE, &[u32::from(code)], None)?;
        match response.data.as_slice() {
            [lo] => Ok(u16::from(*lo)),
            [lo, hi, ..] => Ok(u16::from_le_bytes([*lo, *hi])),
            [] => Err(Error::Protocol("empty property value".to_owned())),
        }
    }

    // ----- capture ----------------------------------------------------------------------

    /// Autofocus, take a picture, wait for it, and return the JPEG.
    pub fn capture(&mut self) -> Result<Capture> {
        self.require_connected()?;
        self.drain_events()?;
        // Never let a leftover object (the RAW companion of the last shot, or a photo from a
        // capture that failed half-way) be mistaken for the picture about to be taken.
        let stale = self.drain_pending()?;
        if stale > 0 {
            tracing::warn!(stale, "discarded objects left over from an earlier capture");
        }
        let started = Instant::now();
        self.shoot()?;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "shutter released; waiting for the image"
        );
        self.wait_for_image()?;
        let capture = self.download_jpeg()?;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            filename = %capture.filename,
            bytes = capture.jpeg.len(),
            width = capture.width,
            height = capture.height,
            "capture complete"
        );
        Ok(capture)
    }

    /// S1 down → AF settle → S2 down → S2 up → S1 up, via a drop-guard.
    pub fn shoot(&mut self) -> Result<()> {
        self.require_connected()?;
        let af_settle = self.cfg.af_settle;
        let mut shutter = ShutterGuard::new(&mut self.ptp);
        shutter.half_press()?;
        sleep(af_settle);
        shutter.full_press()?;
        shutter.release()
    }

    /// Downloads and discards every object still waiting in the camera, returning how many.
    ///
    /// With RAW+JPEG quality the camera delivers the JPEG first and keeps the RAW pending; left
    /// alone it is fetched (and thrown away) at the start of the *next* capture, costing seconds.
    /// Cheap when nothing is pending (one property read).
    pub fn drain_pending(&mut self) -> Result<u32> {
        let mut drained = 0;
        for _ in 0..self.cfg.max_objects_per_capture.max(8) {
            match self.property_u16(prop::OBJECT_IN_MEMORY) {
                Ok(v) if v >= OBJECT_IN_MEMORY_READY => {}
                _ => break,
            }
            let response =
                self.ptp
                    .transaction(op::GET_OBJECT_INFO, &[handle::CAPTURED_IMAGE], None)?;
            if !response.is_ok() {
                break;
            }
            let info = ObjectInfo::parse(&response.data)?;
            tracing::debug!(
                filename = %info.filename,
                size = info.compressed_size,
                "discarding a pending object"
            );
            self.download_object(handle::CAPTURED_IMAGE, info.compressed_size)?;
            drained += 1;
        }
        Ok(drained)
    }

    fn drain_events(&mut self) -> Result<()> {
        // Bounded so a camera that streams events cannot stall a capture.
        for _ in 0..32 {
            if self.ptp.poll_event(self.cfg.poll_interval)?.is_none() {
                break;
            }
        }
        Ok(())
    }

    /// Ready when either the camera announces the new object or `ObjectInMemory` says so.
    /// Property read failures are tolerated while there is still time: the event or a retried
    /// `GetObjectInfo` may yet succeed.
    pub fn wait_for_image(&mut self) -> Result<()> {
        let started = Instant::now();
        let deadline = started + self.cfg.image_timeout;
        loop {
            if let Some(ev) = self.ptp.poll_event(self.cfg.poll_interval)? {
                tracing::debug!(code = ev.code, params = ?ev.params, "camera event");
                let added = matches!(ev.code, event::SONY_OBJECT_ADDED | event::OBJECT_ADDED);
                if added && ev.params.first() == Some(&handle::CAPTURED_IMAGE) {
                    tracing::info!(
                        waited_ms = started.elapsed().as_millis() as u64,
                        "image ready (ObjectAdded event)"
                    );
                    return Ok(());
                }
            }
            match self.property_u16(prop::OBJECT_IN_MEMORY) {
                Ok(v) if v >= OBJECT_IN_MEMORY_READY => {
                    tracing::info!(
                        waited_ms = started.elapsed().as_millis() as u64,
                        object_in_memory = format_args!("{v:#06x}"),
                        "image ready (ObjectInMemory)"
                    );
                    return Ok(());
                }
                Ok(_) => {}
                Err(e @ Error::Io(_)) => return Err(e),
                Err(e) => tracing::debug!(%e, "ObjectInMemory not readable; relying on events"),
            }
            if Instant::now() >= deadline {
                return Err(Error::Timeout(
                    "captured image never appeared in camera memory",
                ));
            }
        }
    }

    fn object_info_with_retry(&mut self, deadline: Instant) -> Result<ObjectInfo> {
        loop {
            let response =
                self.ptp
                    .transaction(op::GET_OBJECT_INFO, &[handle::CAPTURED_IMAGE], None)?;
            match response.code {
                rc::OK => return ObjectInfo::parse(&response.data),
                rc::INVALID_OBJECT_HANDLE | rc::DEVICE_BUSY if Instant::now() < deadline => {
                    sleep(self.cfg.poll_interval);
                }
                code => return Err(Error::response("GetObjectInfo", code)),
            }
        }
    }

    /// Fetches objects until a JPEG turns up. A RAW companion (RAW+JPEG quality) must be
    /// consumed to advance the camera's buffer but is discarded.
    pub fn download_jpeg(&mut self) -> Result<Capture> {
        let deadline = Instant::now() + self.cfg.image_timeout;
        for _ in 0..self.cfg.max_objects_per_capture {
            let info = self.object_info_with_retry(deadline)?;
            tracing::info!(
                filename = %info.filename,
                format = format_args!("{:#06x}", info.format),
                size = info.compressed_size,
                width = info.width,
                height = info.height,
                "downloading the captured object"
            );
            let bytes = self.download_object(handle::CAPTURED_IMAGE, info.compressed_size)?;
            if info.format == format::SONY_RAW {
                tracing::debug!(filename = %info.filename, "discarding RAW companion");
                continue;
            }
            let (width, height) = if info.width > 0 && info.height > 0 {
                (info.width, info.height)
            } else {
                jpeg::dimensions(&bytes).unwrap_or((0, 0))
            };
            return Ok(Capture {
                jpeg: bytes,
                width,
                height,
                filename: info.filename,
            });
        }
        Err(Error::Protocol(
            "camera produced no JPEG; set Quality to JPEG or RAW+JPEG".to_owned(),
        ))
    }

    fn download_object(&mut self, object: u32, size: u32) -> Result<Vec<u8>> {
        if size > self.cfg.chunk_threshold {
            tracing::info!(size, chunk = self.cfg.chunk_size, "using chunked download");
            match self.download_chunked(object, size) {
                Ok(bytes) => return Ok(bytes),
                Err(Error::Response {
                    code: rc::OPERATION_NOT_SUPPORTED,
                    ..
                }) => tracing::info!("chunked download unsupported; falling back to GetObject"),
                Err(e) => return Err(e),
            }
        }
        Ok(self.ptp.call(op::GET_OBJECT, &[object], None)?.data)
    }

    /// `SDIO_GetPartialLargeObject(handle, offset_low, offset_high, length)`.
    fn download_chunked(&mut self, object: u32, size: u32) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(size as usize);
        while (out.len() as u64) < u64::from(size) {
            let offset = out.len() as u64;
            let want = self.cfg.chunk_size.min(size - offset as u32);
            let chunk = self.ptp.call(
                op::SDIO_GET_PARTIAL_LARGE_OBJECT,
                &[object, offset as u32, (offset >> 32) as u32, want],
                None,
            )?;
            if chunk.data.is_empty() {
                return Err(Error::Protocol(format!(
                    "camera returned an empty chunk at offset {offset} of {size}"
                )));
            }
            out.extend_from_slice(&chunk.data);
        }
        out.truncate(size as usize);
        Ok(out)
    }

    // ----- live view --------------------------------------------------------------------

    /// There is no explicit start command: live view is "on" once `LiveViewStatus` is non-zero.
    pub fn wait_for_live_view(&mut self) -> Result<()> {
        self.require_connected()?;
        let deadline = Instant::now() + self.cfg.live_view_timeout;
        loop {
            if self.property_u16(prop::LIVE_VIEW_STATUS)? != 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(Error::Timeout("live view never became active"));
            }
            sleep(self.cfg.poll_interval);
        }
    }

    /// Fetches the current live-view frame. `Ok(None)` means none is available right now
    /// (busy, or no JPEG in the payload); callers should retry.
    pub fn live_frame(&mut self) -> Result<Option<Vec<u8>>> {
        self.require_connected()?;
        let response = self
            .ptp
            .transaction(op::GET_OBJECT, &[handle::LIVE_VIEW], None)?;
        match response.code {
            rc::OK => Ok(jpeg::extract_jpeg(&response.data).map(<[u8]>::to_vec)),
            rc::DEVICE_BUSY | rc::INVALID_OBJECT_HANDLE => Ok(None),
            code => Err(Error::response("GetObject(live view)", code)),
        }
    }
}
