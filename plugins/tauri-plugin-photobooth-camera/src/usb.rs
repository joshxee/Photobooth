//! The wired Sony A7 III on Android: Kotlin finds the device and opens it, Rust drives it.
//!
//! # File-descriptor lifetime contract
//!
//! `usbOpen` returns a `dup()` of the fd inside Kotlin's `UsbDeviceConnection`. libusb's
//! `open_device_with_fd` does **not** take ownership of it, and — importantly — the USB
//! permission grant lives on the Kotlin `UsbDeviceConnection` object, not on the fd number: if
//! Kotlin closes its connection while Rust's transport is still alive, later libusb calls fail
//! even though the integer is still an open fd. So the order is always:
//!
//! 1. build the transport from the fd,
//! 2. use it,
//! 3. **drop the transport** (`SonyCamera::release`),
//! 4. only then call `usbClose`.
//!
//! [`UsbSonyCamera`] owns that order, including on every failure path.

use std::sync::Arc;

use async_trait::async_trait;
use photobooth_core::{Camera, CameraError, CameraId, CameraStatus, CapturedPhoto, FrameStream};
use sony_ptp::{SonyCamera, SonyConfig, Transport};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::models::{UsbDeviceInfo, SONY_VENDOR_ID};
use crate::PhotoboothCamera;

/// What `UsbSonyCamera` needs from the Kotlin side.
#[async_trait]
pub trait UsbBackend: Send + Sync {
    async fn list(&self) -> Result<Vec<UsbDeviceInfo>, String>;
    async fn request_permission(&self, device_name: &str) -> Result<bool, String>;
    async fn open(&self, device_name: &str) -> Result<i32, String>;
    async fn close(&self, device_name: &str) -> Result<(), String>;
}

#[async_trait]
impl<R: tauri::Runtime> UsbBackend for PhotoboothCamera<R> {
    async fn list(&self) -> Result<Vec<UsbDeviceInfo>, String> {
        self.usb_list()
            .await
            .map(|r| r.devices)
            .map_err(|e| e.to_string())
    }

    async fn request_permission(&self, device_name: &str) -> Result<bool, String> {
        self.usb_request_permission(device_name)
            .await
            .map(|r| r.granted)
            .map_err(|e| e.to_string())
    }

    async fn open(&self, device_name: &str) -> Result<i32, String> {
        self.usb_open(device_name)
            .await
            .map(|r| r.fd)
            .map_err(|e| e.to_string())
    }

    async fn close(&self, device_name: &str) -> Result<(), String> {
        self.usb_close(device_name).await.map_err(|e| e.to_string())
    }
}

/// Lets the app hand an `AppHandle` to [`UsbSonyCamera`] instead of an owned handle to the
/// plugin's managed state.
#[async_trait]
impl<R: tauri::Runtime> UsbBackend for tauri::AppHandle<R> {
    async fn list(&self) -> Result<Vec<UsbDeviceInfo>, String> {
        crate::PhotoboothCameraExt::photobooth_camera(self)
            .list()
            .await
    }

    async fn request_permission(&self, device_name: &str) -> Result<bool, String> {
        UsbBackend::request_permission(
            crate::PhotoboothCameraExt::photobooth_camera(self),
            device_name,
        )
        .await
    }

    async fn open(&self, device_name: &str) -> Result<i32, String> {
        UsbBackend::open(
            crate::PhotoboothCameraExt::photobooth_camera(self),
            device_name,
        )
        .await
    }

    async fn close(&self, device_name: &str) -> Result<(), String> {
        UsbBackend::close(
            crate::PhotoboothCameraExt::photobooth_camera(self),
            device_name,
        )
        .await
    }
}

/// Turns a file descriptor into a PTP [`Transport`]. A trait so tests can substitute a
/// simulated camera for libusb.
pub trait TransportFactory: Send + Sync {
    fn open(&self, fd: i32) -> sony_ptp::Result<Box<dyn Transport>>;
}

/// The libusb transport over an Android-provided file descriptor.
pub struct AndroidUsbTransport(sony_ptp::RusbTransport<rusb::Context>);

impl AndroidUsbTransport {
    /// Wraps `fd` (from `usbOpen`). Three `rusb` facts this relies on:
    ///
    /// 1. there is no `UsbOption::no_device_discovery()`; the real API is the free function
    ///    [`rusb::disable_device_discovery`], and it must run **before** `Context::new()`;
    /// 2. `open_device_with_fd` is a method of the `UsbContext` trait and is `unsafe` and
    ///    `#[cfg(unix)]` in `rusb` itself (hence the non-unix stub below);
    /// 3. the fd is a duplicate that libusb does not take ownership of — see the module docs
    ///    for the drop-before-`usbClose` rule.
    #[cfg(unix)]
    pub fn from_fd(fd: i32) -> sony_ptp::Result<Self> {
        use rusb::UsbContext;
        use std::sync::Once;

        // Android apps cannot enumerate USB devices through libusb; without this it fails to
        // initialise. Once per process is enough.
        static NO_DISCOVERY: Once = Once::new();
        NO_DISCOVERY.call_once(|| {
            if let Err(err) = rusb::disable_device_discovery() {
                tracing::warn!(%err, "could not disable libusb device discovery");
            }
        });

        let io = |e: rusb::Error| sony_ptp::Error::Io(e.to_string());
        let context = rusb::Context::new().map_err(io)?;
        // SAFETY: `fd` is an open USB device descriptor handed over by Kotlin, which keeps the
        // owning `UsbDeviceConnection` open until `usbClose` — and `UsbSonyCamera` only calls
        // that after this transport has been dropped.
        let handle = unsafe { context.open_device_with_fd(fd) }.map_err(io)?;
        Ok(Self(sony_ptp::RusbTransport::from_handle(handle)?))
    }

    #[cfg(not(unix))]
    pub fn from_fd(_fd: i32) -> sony_ptp::Result<Self> {
        Err(sony_ptp::Error::Io(
            "opening a USB device from a file descriptor needs a unix target".to_owned(),
        ))
    }
}

impl Transport for AndroidUsbTransport {
    fn write_bulk(&mut self, buf: &[u8], timeout: std::time::Duration) -> sony_ptp::Result<usize> {
        self.0.write_bulk(buf, timeout)
    }

    fn read_bulk(
        &mut self,
        buf: &mut [u8],
        timeout: std::time::Duration,
    ) -> sony_ptp::Result<usize> {
        self.0.read_bulk(buf, timeout)
    }

    fn read_interrupt(
        &mut self,
        buf: &mut [u8],
        timeout: std::time::Duration,
    ) -> sony_ptp::Result<usize> {
        self.0.read_interrupt(buf, timeout)
    }

    fn reset(&mut self) -> sony_ptp::Result<()> {
        self.0.reset()
    }
}

/// The production factory.
pub struct AndroidUsbFactory;

impl TransportFactory for AndroidUsbFactory {
    fn open(&self, fd: i32) -> sony_ptp::Result<Box<dyn Transport>> {
        Ok(Box::new(AndroidUsbTransport::from_fd(fd)?))
    }
}

type Engine = SonyCamera<Box<dyn Transport>>;

struct Connection {
    device: String,
    camera: Arc<Engine>,
    /// Mirrors the inner camera's status onto the outer one.
    forwarder: JoinHandle<()>,
}

const NO_DEVICE: &str =
    "No Sony camera found. Connect it with a USB cable and set USB Connection to PC Remote.";

/// A Sony camera that is built lazily when connected (there is no device at app start) and
/// torn down — in the right order — when disconnected, unplugged or failed.
pub struct UsbSonyCamera<B: UsbBackend + 'static> {
    backend: Arc<B>,
    factory: Arc<dyn TransportFactory>,
    config: SonyConfig,
    connection: tokio::sync::Mutex<Option<Connection>>,
    status: Arc<watch::Sender<CameraStatus>>,
}

impl<B: UsbBackend + 'static> UsbSonyCamera<B> {
    pub fn new(backend: Arc<B>, factory: Arc<dyn TransportFactory>) -> Self {
        Self::with_config(backend, factory, SonyConfig::default())
    }

    pub fn with_config(
        backend: Arc<B>,
        factory: Arc<dyn TransportFactory>,
        config: SonyConfig,
    ) -> Self {
        Self {
            backend,
            factory,
            config,
            connection: tokio::sync::Mutex::new(None),
            status: Arc::new(watch::channel(CameraStatus::Disconnected).0),
        }
    }

    /// `None` when a Sony camera is attached; otherwise why the camera cannot be used now.
    pub async fn unavailable_reason(&self) -> Option<String> {
        match self.backend.list().await {
            Ok(devices) if devices.iter().any(|d| d.vendor_id == SONY_VENDOR_ID) => None,
            Ok(_) => Some(NO_DEVICE.to_owned()),
            Err(err) => Some(err),
        }
    }

    /// Releases the transport first, then tells Kotlin to close its connection.
    async fn teardown(&self, connection: Connection) {
        connection.forwarder.abort();
        connection.camera.release().await;
        if let Err(err) = self.backend.close(&connection.device).await {
            tracing::warn!(%err, device = %connection.device, "usbClose failed");
        }
    }

    async fn establish(&self) -> Result<Connection, (CameraError, String)> {
        let io = |message: String| (CameraError::Io(message.clone()), message);

        let devices = self.backend.list().await.map_err(io)?;
        let device = devices
            .into_iter()
            .find(|d| d.vendor_id == SONY_VENDOR_ID)
            .ok_or_else(|| (CameraError::NotConnected, NO_DEVICE.to_owned()))?;

        if !device.has_permission {
            let granted = self
                .backend
                .request_permission(&device.device_name)
                .await
                .map_err(io)?;
            if !granted {
                return Err(io(
                    "USB permission for the camera was denied. Unplug it, plug it in again and choose OK."
                        .to_owned(),
                ));
            }
        }

        let fd = self.backend.open(&device.device_name).await.map_err(io)?;
        let transport = match self.factory.open(fd) {
            Ok(transport) => transport,
            Err(err) => {
                let _ = self.backend.close(&device.device_name).await;
                return Err(io(err.to_string()));
            }
        };

        let camera = Arc::new(SonyCamera::with_config(transport, self.config.clone()));
        if let Err(err) = camera.connect().await {
            // Order matters even on failure: drop the transport, then close.
            camera.release().await;
            let _ = self.backend.close(&device.device_name).await;
            let message = err.to_string();
            return Err((err, message));
        }

        let mut inner = camera.status();
        let outer = self.status.clone();
        // Settle the outer status *before* returning: a caller that sees `connect()` succeed
        // must not still observe `Connecting` because the forwarder has not run yet.
        outer.send_replace(inner.borrow_and_update().clone());
        let forwarder = tokio::spawn(async move {
            while inner.changed().await.is_ok() {
                outer.send_replace(inner.borrow_and_update().clone());
            }
        });
        Ok(Connection {
            device: device.device_name,
            camera,
            forwarder,
        })
    }

    async fn current(&self) -> Result<Arc<Engine>, CameraError> {
        self.connection
            .lock()
            .await
            .as_ref()
            .map(|c| c.camera.clone())
            .ok_or(CameraError::NotConnected)
    }
}

#[async_trait]
impl<B: UsbBackend + 'static> Camera for UsbSonyCamera<B> {
    fn id(&self) -> CameraId {
        CameraId::SONY_USB
    }

    async fn connect(&self) -> Result<(), CameraError> {
        let mut slot = self.connection.lock().await;
        if let Some(existing) = slot.as_ref() {
            if matches!(
                *existing.camera.status().borrow(),
                CameraStatus::Ready | CameraStatus::Busy
            ) {
                return Ok(());
            }
            // Errored or unplugged: rebuild from scratch rather than reuse a wedged pipe.
            if let Some(stale) = slot.take() {
                self.teardown(stale).await;
            }
        }

        self.status.send_replace(CameraStatus::Connecting);
        match self.establish().await {
            Ok(connection) => {
                *slot = Some(connection);
                Ok(())
            }
            Err((error, message)) => {
                self.status.send_replace(CameraStatus::Error(message));
                Err(error)
            }
        }
    }

    async fn disconnect(&self) -> Result<(), CameraError> {
        let connection = self.connection.lock().await.take();
        if let Some(connection) = connection {
            self.teardown(connection).await;
        }
        self.status.send_replace(CameraStatus::Disconnected);
        Ok(())
    }

    fn status(&self) -> watch::Receiver<CameraStatus> {
        self.status.subscribe()
    }

    async fn start_live_view(&self) -> Result<FrameStream, CameraError> {
        self.current().await?.start_live_view().await
    }

    async fn stop_live_view(&self) -> Result<(), CameraError> {
        match self.current().await {
            Ok(camera) => camera.stop_live_view().await,
            Err(_) => Ok(()),
        }
    }

    async fn capture(&self) -> Result<CapturedPhoto, CameraError> {
        self.current().await?.capture().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sony_ptp::sim::{Fault, SimConfig, SimTransport};
    use std::sync::Mutex;
    use std::time::Duration;

    type Log = Arc<Mutex<Vec<String>>>;

    fn events(log: &Log) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    struct FakeUsb {
        log: Log,
        devices: Mutex<Vec<UsbDeviceInfo>>,
        grant: bool,
        fd: i32,
        fail_open: bool,
    }

    fn sony(has_permission: bool) -> UsbDeviceInfo {
        UsbDeviceInfo {
            device_name: "/dev/bus/usb/001/004".into(),
            vendor_id: SONY_VENDOR_ID,
            product_id: 0x0E73,
            product_name: Some("ILCE-7M3".into()),
            has_permission,
        }
    }

    impl FakeUsb {
        fn new(log: &Log, devices: Vec<UsbDeviceInfo>) -> Arc<Self> {
            Arc::new(Self {
                log: log.clone(),
                devices: Mutex::new(devices),
                grant: true,
                fd: 7,
                fail_open: false,
            })
        }

        fn log(&self, event: String) {
            self.log.lock().unwrap().push(event);
        }
    }

    #[async_trait]
    impl UsbBackend for FakeUsb {
        async fn list(&self) -> Result<Vec<UsbDeviceInfo>, String> {
            self.log("list".into());
            Ok(self.devices.lock().unwrap().clone())
        }

        async fn request_permission(&self, name: &str) -> Result<bool, String> {
            self.log(format!("permission:{name}"));
            Ok(self.grant)
        }

        async fn open(&self, name: &str) -> Result<i32, String> {
            self.log(format!("open:{name}"));
            if self.fail_open {
                Err("could not open".into())
            } else {
                Ok(self.fd)
            }
        }

        async fn close(&self, name: &str) -> Result<(), String> {
            self.log(format!("close:{name}"));
            Ok(())
        }
    }

    /// Wraps a simulated camera and logs when it is dropped.
    struct Recorded {
        inner: SimTransport,
        log: Log,
    }

    impl Drop for Recorded {
        fn drop(&mut self) {
            self.log.lock().unwrap().push("transport_dropped".into());
        }
    }

    impl Transport for Recorded {
        fn write_bulk(&mut self, buf: &[u8], t: Duration) -> sony_ptp::Result<usize> {
            self.inner.write_bulk(buf, t)
        }
        fn read_bulk(&mut self, buf: &mut [u8], t: Duration) -> sony_ptp::Result<usize> {
            self.inner.read_bulk(buf, t)
        }
        fn read_interrupt(&mut self, buf: &mut [u8], t: Duration) -> sony_ptp::Result<usize> {
            self.inner.read_interrupt(buf, t)
        }
        fn reset(&mut self) -> sony_ptp::Result<()> {
            self.inner.reset()
        }
    }

    struct FakeFactory {
        log: Log,
        /// One simulated camera config per `open`; the last one is reused once the rest are
        /// used up (so a one-shot fault only affects the first connection).
        sims: Mutex<std::collections::VecDeque<SimConfig>>,
        fail: bool,
    }

    impl TransportFactory for FakeFactory {
        fn open(&self, fd: i32) -> sony_ptp::Result<Box<dyn Transport>> {
            self.log.lock().unwrap().push(format!("factory:{fd}"));
            if self.fail {
                return Err(sony_ptp::Error::Io("libusb refused the descriptor".into()));
            }
            let config = {
                let mut sims = self.sims.lock().unwrap();
                if sims.len() > 1 {
                    sims.pop_front().expect("non-empty")
                } else {
                    sims.front().cloned().expect("at least one config")
                }
            };
            let (inner, _) = SimTransport::new(config);
            Ok(Box::new(Recorded {
                inner,
                log: self.log.clone(),
            }))
        }
    }

    fn camera(
        log: &Log,
        usb: Arc<FakeUsb>,
        sim: SimConfig,
        fail_factory: bool,
    ) -> UsbSonyCamera<FakeUsb> {
        camera_with_sims(log, usb, vec![sim], fail_factory)
    }

    fn camera_with_sims(
        log: &Log,
        usb: Arc<FakeUsb>,
        sims: Vec<SimConfig>,
        fail_factory: bool,
    ) -> UsbSonyCamera<FakeUsb> {
        UsbSonyCamera::with_config(
            usb,
            Arc::new(FakeFactory {
                log: log.clone(),
                sims: Mutex::new(sims.into()),
                fail: fail_factory,
            }),
            SonyConfig::no_delays(),
        )
    }

    fn new_log() -> Log {
        Arc::new(Mutex::new(Vec::new()))
    }

    // ----- the happy path and its ordering -----------------------------------------

    #[tokio::test]
    async fn connect_asks_for_permission_opens_then_builds_the_transport_and_captures() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(false)]);
        let cam = camera(&log, usb, SimConfig::default(), false);

        cam.connect().await.unwrap();
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
        assert_eq!(
            events(&log),
            vec![
                "list",
                "permission:/dev/bus/usb/001/004",
                "open:/dev/bus/usb/001/004",
                "factory:7",
            ]
        );

        let photo = cam.capture().await.unwrap();
        assert!(photo.jpeg.starts_with(&[0xFF, 0xD8]));
    }

    #[tokio::test]
    async fn an_already_granted_permission_is_not_requested_again() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        let cam = camera(&log, usb, SimConfig::default(), false);
        cam.connect().await.unwrap();
        assert!(!events(&log).iter().any(|e| e.starts_with("permission")));
    }

    #[tokio::test]
    async fn disconnect_drops_the_transport_before_closing_the_usb_connection() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        let cam = camera(&log, usb, SimConfig::default(), false);
        cam.connect().await.unwrap();

        cam.disconnect().await.unwrap();

        let ev = events(&log);
        let dropped = ev
            .iter()
            .position(|e| e == "transport_dropped")
            .expect("dropped");
        let closed = ev
            .iter()
            .position(|e| e.starts_with("close:"))
            .expect("closed");
        assert!(
            dropped < closed,
            "fd lifetime contract: transport must be dropped before usbClose; got {ev:?}"
        );
        assert_eq!(*cam.status().borrow(), CameraStatus::Disconnected);
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::NotConnected);
    }

    #[tokio::test]
    async fn the_same_order_holds_when_the_handshake_fails() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        let wrong_mode = SimConfig {
            pc_remote: false,
            ..SimConfig::default()
        };
        let cam = camera(&log, usb, wrong_mode, false);

        let err = cam.connect().await.unwrap_err();
        assert!(
            matches!(&err, CameraError::Protocol(m) if m.contains("PC Remote")),
            "{err}"
        );
        assert!(matches!(
            &*cam.status().borrow(),
            CameraStatus::Error(m) if m.contains("PC Remote")
        ));

        let ev = events(&log);
        let dropped = ev.iter().position(|e| e == "transport_dropped").unwrap();
        let closed = ev.iter().position(|e| e.starts_with("close:")).unwrap();
        assert!(dropped < closed, "{ev:?}");
    }

    // ----- failure paths ------------------------------------------------------------

    #[tokio::test]
    async fn no_camera_attached_is_a_clear_error_and_nothing_is_opened() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![]);
        let cam = camera(&log, usb, SimConfig::default(), false);
        assert_eq!(cam.connect().await.unwrap_err(), CameraError::NotConnected);
        assert!(matches!(
            &*cam.status().borrow(),
            CameraStatus::Error(m) if m.contains("PC Remote")
        ));
        assert_eq!(events(&log), vec!["list"]);
    }

    #[tokio::test]
    async fn only_sony_devices_are_considered() {
        let log = new_log();
        let mut other = sony(true);
        other.vendor_id = 0x1234;
        let usb = FakeUsb::new(&log, vec![other]);
        let cam = camera(&log, usb, SimConfig::default(), false);
        assert!(cam.connect().await.is_err());
        assert!(!events(&log).iter().any(|e| e.starts_with("open")));
    }

    #[tokio::test]
    async fn a_denied_usb_permission_stops_before_opening() {
        let log = new_log();
        let usb = Arc::new(FakeUsb {
            grant: false,
            ..Arc::try_unwrap(FakeUsb::new(&log, vec![sony(false)]))
                .ok()
                .unwrap()
        });
        let cam = camera(&log, usb, SimConfig::default(), false);
        let err = cam.connect().await.unwrap_err();
        assert!(
            matches!(&err, CameraError::Io(m) if m.contains("permission")),
            "{err}"
        );
        assert!(!events(&log).iter().any(|e| e.starts_with("open")));
    }

    #[tokio::test]
    async fn a_factory_failure_still_closes_the_usb_connection() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        let cam = camera(&log, usb, SimConfig::default(), true);
        let err = cam.connect().await.unwrap_err();
        assert!(
            matches!(&err, CameraError::Io(m) if m.contains("libusb")),
            "{err}"
        );
        let ev = events(&log);
        assert_eq!(
            ev.last().map(String::as_str),
            Some("close:/dev/bus/usb/001/004")
        );
        assert!(
            !ev.contains(&"transport_dropped".to_owned()),
            "no transport existed"
        );
    }

    #[tokio::test]
    async fn a_failed_open_is_reported() {
        let log = new_log();
        let usb = Arc::new(FakeUsb {
            fail_open: true,
            ..Arc::try_unwrap(FakeUsb::new(&log, vec![sony(true)]))
                .ok()
                .unwrap()
        });
        let cam = camera(&log, usb, SimConfig::default(), false);
        assert!(matches!(
            cam.connect().await.unwrap_err(),
            CameraError::Io(m) if m == "could not open"
        ));
        assert!(!events(&log).iter().any(|e| e.starts_with("factory")));
    }

    // ----- reconnecting ---------------------------------------------------------------

    #[tokio::test]
    async fn connect_is_idempotent_while_the_camera_is_healthy() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        let cam = camera(&log, usb, SimConfig::default(), false);
        cam.connect().await.unwrap();
        let before = events(&log).len();
        cam.connect().await.unwrap();
        assert_eq!(events(&log).len(), before);
    }

    #[tokio::test]
    async fn reconnect_after_disconnect_builds_a_fresh_transport() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        let cam = camera(&log, usb, SimConfig::default(), false);
        cam.connect().await.unwrap();
        cam.disconnect().await.unwrap();
        cam.connect().await.unwrap();
        cam.capture().await.unwrap();
        let opens = events(&log)
            .iter()
            .filter(|e| e.starts_with("open:"))
            .count();
        assert_eq!(opens, 2);
    }

    #[tokio::test]
    async fn a_wedged_pipe_is_torn_down_and_rebuilt_on_the_next_connect() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        // The first shutter command fails at the transport (as an unplugged cable would).
        let sim = SimConfig {
            faults: vec![Fault::WriteError {
                op: sony_ptp::codes::op::SDIO_CONTROL_DEVICE,
                nth: 1,
            }],
            ..SimConfig::default()
        };
        // Only the first connection is faulty; the rebuilt one is healthy.
        let cam = camera_with_sims(&log, usb, vec![sim, SimConfig::default()], false);
        cam.connect().await.unwrap();
        assert!(cam.capture().await.is_err());
        let mut status = cam.status();
        tokio::time::timeout(
            Duration::from_secs(2),
            status.wait_for(|s| matches!(s, CameraStatus::Error(_))),
        )
        .await
        .expect("status turns to error")
        .unwrap();

        cam.connect().await.expect("rebuilds");
        let ev = events(&log);
        // old transport dropped, old connection closed, then a new open.
        let first_close = ev
            .iter()
            .position(|e| e.starts_with("close:"))
            .expect("closed old");
        let second_open = ev
            .iter()
            .enumerate()
            .filter(|(_, e)| e.starts_with("open:"))
            .nth(1)
            .map(|(i, _)| i)
            .expect("reopened");
        assert!(first_close < second_open, "{ev:?}");
        cam.capture().await.expect("works again");
    }

    // ----- availability ---------------------------------------------------------------

    #[tokio::test]
    async fn availability_tracks_whether_a_sony_camera_is_attached() {
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![]);
        let cam = camera(&log, usb.clone(), SimConfig::default(), false);
        assert!(cam
            .unavailable_reason()
            .await
            .unwrap()
            .contains("PC Remote"));

        usb.devices.lock().unwrap().push(sony(false));
        assert_eq!(cam.unavailable_reason().await, None);
    }

    #[tokio::test]
    async fn operations_before_connecting_are_not_connected() {
        let log = new_log();
        let cam = camera(
            &log,
            FakeUsb::new(&log, vec![sony(true)]),
            SimConfig::default(),
            false,
        );
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::NotConnected);
        assert!(matches!(
            cam.start_live_view().await,
            Err(CameraError::NotConnected)
        ));
        cam.stop_live_view().await.unwrap();
        assert_eq!(cam.id(), CameraId::SONY_USB);
    }

    #[tokio::test]
    async fn live_view_streams_through_the_wrapper() {
        use futures_util::StreamExt;
        let log = new_log();
        let usb = FakeUsb::new(&log, vec![sony(true)]);
        let cam = camera(&log, usb, SimConfig::default(), false);
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        assert!(frames
            .next()
            .await
            .expect("a frame")
            .starts_with(&[0xFF, 0xD8]));
        cam.disconnect().await.unwrap();
        while frames.next().await.is_some() {}
    }
}
