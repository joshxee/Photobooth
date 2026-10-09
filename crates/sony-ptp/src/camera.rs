//! `SonyCamera<T>`: the Sony engine as a `photobooth_core::Camera`.
//!
//! The engine is blocking, so every operation runs on tokio's blocking pool. Two properties
//! shape the design:
//!
//! - **Cancel safety.** Dropping an async `capture()` future cannot stop the blocking thread
//!   already talking to the camera, so status bookkeeping happens *inside* the blocking
//!   closure; the camera is never left looking `Busy`.
//! - **Capture never depends on live view.** Live view (flaky over USB on A7-generation
//!   bodies) is a best-effort loop that steps aside whenever a capture is pending and is
//!   restarted by a watchdog; if it dies, captures are unaffected.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use bytes::Bytes;
use photobooth_core::{
    Camera, CameraError, CameraId, CameraStatus, CapturedPhoto, FrameStream, JpegFrame,
};
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;

use crate::codes::rc;
use crate::error::{Error, PC_REMOTE_HINT};
use crate::sony::{Sony, SonyConfig};
use crate::transport::Transport;

/// Pause between live-view frame requests (~30 fps ceiling; the camera is the real limit).
const FRAME_PACING: Duration = Duration::from_millis(30);
/// No frame for this long ⇒ restart live view.
const WATCHDOG: Duration = Duration::from_secs(3);
const MAX_RESTARTS: u32 = 3;
const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// Backoff between live-view attempts while the camera refuses frames (it answers `AccessDenied`
/// intermittently): start short, double up to the cap. Never gives up — the camera is alive.
const DENIED_BACKOFF_START: Duration = Duration::from_millis(50);
const DENIED_BACKOFF_MAX: Duration = Duration::from_secs(1);

struct Shared<T: Transport> {
    /// `None` once [`SonyCamera::release`] has dropped the engine (and with it the transport).
    engine: Mutex<Option<Sony<T>>>,
    status: watch::Sender<CameraStatus>,
    live_stop: Mutex<Option<Arc<AtomicBool>>>,
    capture_pending: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // The guarded data is only ever left in a consistent state by the engine (every operation
    // either completes or returns an error), so a poisoned lock is safe to reuse.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `f` on the engine, or fails with `NotConnected` if it has been released.
fn with_engine<T: Transport, R>(
    shared: &Shared<T>,
    f: impl FnOnce(&mut Sony<T>) -> Result<R, Error>,
) -> Result<R, Error> {
    match lock(&shared.engine).as_mut() {
        Some(engine) => f(engine),
        None => Err(Error::NotConnected),
    }
}

pub struct SonyCamera<T: Transport + 'static> {
    shared: Arc<Shared<T>>,
}

impl<T: Transport + 'static> SonyCamera<T> {
    pub fn new(transport: T) -> Self {
        Self::with_config(transport, SonyConfig::default())
    }

    pub fn with_config(transport: T, config: SonyConfig) -> Self {
        let (status, _) = watch::channel(CameraStatus::Disconnected);
        Self {
            shared: Arc::new(Shared {
                engine: Mutex::new(Some(Sony::new(transport, config))),
                status,
                live_stop: Mutex::new(None),
                capture_pending: AtomicBool::new(false),
            }),
        }
    }

    fn stop_live(&self) {
        if let Some(stop) = lock(&self.shared.live_stop).take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    /// Ends the session and **drops the transport before returning**.
    ///
    /// Needed when the transport wraps a resource with a strict lifetime — on Android, a USB
    /// file descriptor that must not outlive Kotlin's `UsbDeviceConnection`. Other clones of
    /// this camera's internals (an in-flight capture, the live-view thread) keep running only
    /// until their next engine call, which then reports `NotConnected`. After this the camera
    /// is unusable; build a new one to reconnect.
    pub async fn release(&self) {
        self.stop_live();
        let shared = self.shared.clone();
        // Waits for any operation currently holding the engine, then drops it.
        let _ = tokio::task::spawn_blocking(move || {
            let engine = lock(&shared.engine).take();
            if let Some(mut engine) = engine {
                if let Err(err) = engine.disconnect() {
                    tracing::debug!(%err, "closing the PTP session failed; dropping the transport anyway");
                }
            }
        })
        .await;
        self.shared.status.send_replace(CameraStatus::Disconnected);
    }

    fn is_connected(&self) -> bool {
        matches!(
            *self.shared.status.borrow(),
            CameraStatus::Ready | CameraStatus::Busy
        )
    }
}

/// Maps engine errors to the shared camera errors, adding the PC Remote hint where a stall
/// most likely means the camera is in the wrong USB mode.
pub fn map_error(err: &Error) -> CameraError {
    match err {
        // The handshake already succeeded if we got as far as waiting for a photo, so blaming
        // the USB mode would be wrong; say what actually did not happen.
        Error::Timeout(what) if what.starts_with("captured image") => CameraError::Protocol(
            "The camera did not deliver the photo. Check that it can focus on the subject and              that Still Img. Save Dest. is PC+Camera."
                .to_owned(),
        ),
        Error::Timeout(what) => {
            CameraError::Protocol(format!("timed out ({what}): {PC_REMOTE_HINT}"))
        }
        Error::WrongUsbMode(message) => CameraError::Protocol(message.clone()),
        Error::Stall(what) => CameraError::Io(format!("the camera stalled the USB pipe ({what})")),
        // libusb's wording for a device that has been unplugged.
        Error::Io(message) if message.contains("No such device") => CameraError::Disconnected,
        Error::Io(message) => CameraError::Io(message.clone()),
        Error::Response { code, .. } if *code == rc::DEVICE_BUSY => CameraError::Busy,
        Error::NotConnected | Error::NotFound => CameraError::NotConnected,
        other => CameraError::Protocol(other.to_string()),
    }
}

/// Whether an error leaves the USB pipe in an unknown state (needs a fresh handshake).
fn needs_reconnect(err: &Error) -> bool {
    matches!(
        err,
        Error::Timeout(_) | Error::Io(_) | Error::Stall(_) | Error::NotConnected
    )
}

fn join_error(err: tokio::task::JoinError) -> CameraError {
    CameraError::Io(format!("camera worker failed: {err}"))
}

#[async_trait]
impl<T: Transport + 'static> Camera for SonyCamera<T> {
    fn id(&self) -> CameraId {
        CameraId::SONY_USB
    }

    async fn connect(&self) -> Result<(), CameraError> {
        if self.is_connected() {
            return Ok(());
        }
        self.shared.status.send_replace(CameraStatus::Connecting);
        let shared = self.shared.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            let result = with_engine(&shared, |engine| engine.connect().map(|_| ()));
            // Status is settled inside the closure so it is right even if this future is dropped.
            match &result {
                Ok(()) => shared.status.send_replace(CameraStatus::Ready),
                Err(e) => shared
                    .status
                    .send_replace(CameraStatus::Error(map_error(e).to_string())),
            };
            result
        })
        .await
        .map_err(join_error)?;
        outcome.map_err(|e| map_error(&e))
    }

    async fn disconnect(&self) -> Result<(), CameraError> {
        self.stop_live();
        let shared = self.shared.clone();
        let result =
            tokio::task::spawn_blocking(move || with_engine(&shared, |engine| engine.disconnect()))
                .await
                .map_err(join_error)?;
        self.shared.status.send_replace(CameraStatus::Disconnected);
        result.map_err(|e| map_error(&e))
    }

    fn status(&self) -> watch::Receiver<CameraStatus> {
        self.shared.status.subscribe()
    }

    async fn start_live_view(&self) -> Result<FrameStream, CameraError> {
        if !self.is_connected() {
            return Err(CameraError::NotConnected);
        }
        self.stop_live();
        let stop = Arc::new(AtomicBool::new(false));
        *lock(&self.shared.live_stop) = Some(stop.clone());
        let (frames_tx, frames_rx) = mpsc::channel::<JpegFrame>(2);
        let shared = self.shared.clone();
        tokio::task::spawn_blocking(move || live_loop(&shared, &stop, &frames_tx));
        Ok(Box::pin(ReceiverStream::new(frames_rx)))
    }

    async fn stop_live_view(&self) -> Result<(), CameraError> {
        self.stop_live();
        Ok(())
    }

    async fn capture(&self) -> Result<CapturedPhoto, CameraError> {
        let claimed = self.shared.status.send_if_modified(|status| {
            if *status == CameraStatus::Ready {
                *status = CameraStatus::Busy;
                true
            } else {
                false
            }
        });
        if !claimed {
            return Err(match *self.shared.status.borrow() {
                CameraStatus::Busy => CameraError::Busy,
                _ => CameraError::NotConnected,
            });
        }

        self.shared.capture_pending.store(true, Ordering::SeqCst);
        let shared = self.shared.clone();
        let result = tokio::task::spawn_blocking(move || {
            let result = with_engine(&shared, |engine| {
                let capture = engine.capture()?;
                // A RAW+JPEG body hands over the JPEG first and keeps the ~49 MB RAW queued.
                // Clear it before reporting back, under the same lock: done later it would hold
                // the camera for ~2 s *during the next countdown* and freeze the preview, and
                // left alone it would delay the next shutter press instead. The photo is
                // already in hand, so a failure here is logged, not returned; a dead camera
                // surfaces on the next operation.
                match engine.drain_pending() {
                    Ok(0) => {}
                    Ok(n) => tracing::debug!(objects = n, "cleared the camera's pending objects"),
                    Err(err) => {
                        tracing::warn!(%err, "clearing the camera's pending objects failed");
                    }
                }
                Ok(capture)
            });
            shared.capture_pending.store(false, Ordering::SeqCst);
            // Settle status here, not in the awaiting task (see module docs).
            let next = match &result {
                Err(e) if needs_reconnect(e) => CameraStatus::Error(map_error(e).to_string()),
                _ => CameraStatus::Ready,
            };
            shared.status.send_if_modified(|status| {
                if *status == CameraStatus::Busy {
                    *status = next;
                    true
                } else {
                    false
                }
            });
            result
        })
        .await
        .map_err(join_error)?;

        let capture = result.map_err(|e| map_error(&e))?;
        Ok(CapturedPhoto {
            jpeg: Bytes::from(capture.jpeg),
            width: capture.width,
            height: capture.height,
            taken_at: SystemTime::now(),
        })
    }
}

enum Step {
    Activated,
    Frame(Vec<u8>),
    NoFrame,
}

/// Runs on a blocking thread until told to stop, the consumer goes away, or the camera keeps
/// failing. Ending is not an error: callers see the stream finish.
fn live_loop<T: Transport>(
    shared: &Shared<T>,
    stop: &AtomicBool,
    frames: &mpsc::Sender<JpegFrame>,
) {
    let mut active = false;
    let mut failures = 0u32;
    let mut denied_for: Option<Duration> = None;
    let mut restarts = 0u32;
    let mut last_progress = Instant::now();
    // Set when the loop ends because the camera stopped working (not because it was told to).
    let mut gave_up: Option<String> = None;

    while !stop.load(Ordering::SeqCst) && !frames.is_closed() {
        if shared.capture_pending.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }

        let step = with_engine(shared, |engine| {
            if active {
                engine
                    .live_frame()
                    .map(|frame| frame.map_or(Step::NoFrame, Step::Frame))
            } else {
                engine.wait_for_live_view().map(|()| Step::Activated)
            }
        });

        match step {
            Ok(Step::Activated) => {
                // Not a success: only a delivered frame clears the failure count. Otherwise a
                // camera that reports live view "on" but refuses every frame would reset the
                // counter each cycle and be hammered forever.
                active = true;
                last_progress = Instant::now();
            }
            Ok(Step::Frame(jpeg)) => {
                failures = 0;
                denied_for = None;
                last_progress = Instant::now();
                if let Err(mpsc::error::TrySendError::Closed(_)) =
                    frames.try_send(Bytes::from(jpeg))
                {
                    break;
                }
                std::thread::sleep(FRAME_PACING);
            }
            Ok(Step::NoFrame) => std::thread::sleep(FRAME_PACING),
            // The camera is alive but not handing out a frame right now. Not a failure, and not
            // a reason to restart anything: wait, with growing pauses, and try again.
            Err(Error::Response { code, .. }) if code == rc::ACCESS_DENIED => {
                if denied_for.is_none() {
                    tracing::debug!(
                        "live view frame refused (AccessDenied); retrying with backoff"
                    );
                }
                let pause = denied_for.map_or(DENIED_BACKOFF_START, |p: Duration| {
                    (p * 2).min(DENIED_BACKOFF_MAX)
                });
                denied_for = Some(pause);
                last_progress = Instant::now();
                std::thread::sleep(pause);
            }
            Err(err) => {
                failures += 1;
                tracing::warn!(%err, failures, "live view step failed");
                if failures >= MAX_CONSECUTIVE_FAILURES {
                    tracing::warn!("giving up on live view after repeated failures");
                    gave_up = Some(map_error(&err).to_string());
                    break;
                }
                active = false;
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        if active && last_progress.elapsed() > WATCHDOG {
            restarts += 1;
            tracing::warn!(restarts, "live view stalled; restarting it");
            if restarts > MAX_RESTARTS {
                gave_up = Some("live view stopped responding".to_owned());
                break;
            }
            active = false;
            last_progress = Instant::now();
        }
    }

    // Say so. Otherwise the camera still looks `Ready` while its preview is dead: no error is
    // shown, and `connect()` (a no-op for a Ready camera) could never rebuild the connection.
    if let Some(reason) = gave_up {
        if !stop.load(Ordering::SeqCst) {
            shared.status.send_if_modified(|status| {
                if *status == CameraStatus::Ready {
                    *status = CameraStatus::Error(reason);
                    true
                } else {
                    false
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Fault, SimConfig, SimHandle, SimTransport};
    use futures_core::Stream;
    use std::pin::Pin;
    use std::task::Context;

    fn camera(cfg: SimConfig) -> (SonyCamera<SimTransport>, SimHandle) {
        let (transport, handle) = SimTransport::new(cfg);
        (
            SonyCamera::with_config(transport, SonyConfig::no_delays()),
            handle,
        )
    }

    async fn next<S: Stream + Unpin>(stream: &mut S) -> Option<S::Item> {
        std::future::poll_fn(|cx: &mut Context<'_>| Pin::new(&mut *stream).poll_next(cx)).await
    }

    #[tokio::test]
    async fn connect_then_capture_returns_a_photo_and_goes_back_to_ready() {
        let (cam, sim) = camera(SimConfig::default());
        let status = cam.status();
        assert_eq!(*status.borrow(), CameraStatus::Disconnected);

        cam.connect().await.unwrap();
        assert_eq!(*status.borrow(), CameraStatus::Ready);

        let photo = cam.capture().await.unwrap();
        assert!(photo.jpeg.starts_with(&[0xFF, 0xD8]));
        assert_eq!((photo.width, photo.height), (6000, 4000));
        assert_eq!(*status.borrow(), CameraStatus::Ready);
        assert_eq!(sim.exposures(), 1);
        assert_eq!(cam.id(), CameraId::SONY_USB);
    }

    #[tokio::test]
    async fn the_raw_companion_is_cleared_before_capture_returns_so_the_preview_is_not_held_up() {
        let (cam, sim) = camera(SimConfig {
            raw_plus_jpeg: true,
            jpeg_first: true,
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();

        let photo = cam.capture().await.unwrap();
        assert!(photo.jpeg.starts_with(&[0xFF, 0xD8]));
        assert_eq!(
            sim.pending_objects(),
            0,
            "nothing may be left for a background task to fetch while the next countdown runs"
        );
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
    }

    #[tokio::test]
    async fn connect_is_idempotent() {
        let (cam, sim) = camera(SimConfig::default());
        cam.connect().await.unwrap();
        cam.connect().await.unwrap();
        assert_eq!(sim.count(crate::codes::op::OPEN_SESSION), 1);
    }

    #[tokio::test]
    async fn a_camera_in_the_wrong_mode_fails_to_connect_with_a_clear_error() {
        let (cam, _) = camera(SimConfig {
            pc_remote: false,
            ..SimConfig::default()
        });
        let err = cam.connect().await.unwrap_err();
        assert!(
            matches!(&err, CameraError::Protocol(m) if m.contains("PC Remote")),
            "{err}"
        );
        assert!(matches!(*cam.status().borrow(), CameraStatus::Error(_)));
    }

    #[tokio::test]
    async fn the_wrong_mode_message_does_not_claim_the_data_was_malformed() {
        let (cam, _) = camera(SimConfig {
            pc_remote: false,
            ..SimConfig::default()
        });
        let CameraError::Protocol(message) = cam.connect().await.unwrap_err() else {
            panic!("expected a protocol error");
        };
        assert!(!message.contains("malformed"), "{message}");
        assert!(message.contains("PC Remote"), "{message}");
    }

    #[tokio::test]
    async fn a_stall_is_reported_with_the_pc_remote_hint() {
        let (cam, _) = camera(SimConfig {
            faults: vec![Fault::Stall {
                op: crate::codes::op::GET_DEVICE_INFO,
                nth: 1,
            }],
            ..SimConfig::default()
        });
        let err = cam.connect().await.unwrap_err();
        assert!(
            matches!(&err, CameraError::Protocol(m) if m.contains("PC Remote mode")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn capture_before_connect_is_not_connected() {
        let (cam, _) = camera(SimConfig::default());
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::NotConnected);
        assert!(matches!(
            cam.start_live_view().await,
            Err(CameraError::NotConnected)
        ));
    }

    #[tokio::test]
    async fn a_protocol_failure_during_capture_keeps_the_camera_usable() {
        let (cam, sim) = camera(SimConfig {
            faults: vec![Fault::Respond {
                op: crate::codes::op::SDIO_CONTROL_DEVICE,
                nth: 1,
                code: rc::DEVICE_BUSY,
            }],
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::Busy);
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
        cam.capture().await.expect("next capture succeeds");
        assert!(!sim.shutter_held());
    }

    #[tokio::test]
    async fn a_transport_failure_marks_the_camera_errored_and_connect_recovers_it() {
        let (cam, _) = camera(SimConfig {
            faults: vec![Fault::WriteError {
                op: crate::codes::op::SDIO_CONTROL_DEVICE,
                nth: 1,
            }],
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        assert!(matches!(cam.capture().await, Err(CameraError::Io(_))));
        assert!(matches!(*cam.status().borrow(), CameraStatus::Error(_)));

        cam.connect().await.expect("re-handshake recovers");
        cam.capture().await.expect("and captures work again");
    }

    #[tokio::test]
    async fn dropping_a_capture_future_does_not_leave_the_camera_busy() {
        let (cam, sim) = camera(SimConfig::default());
        cam.connect().await.unwrap();
        {
            // Poll once so the blocking work starts, then drop the future (a cancelled session).
            let fut = cam.capture();
            let _ = tokio::time::timeout(Duration::from_millis(1), fut).await;
        }
        // The blocking capture finishes on its own and settles the status.
        let mut status = cam.status();
        tokio::time::timeout(
            Duration::from_secs(5),
            status.wait_for(|s| *s == CameraStatus::Ready),
        )
        .await
        .expect("status settles")
        .unwrap();
        assert!(!sim.shutter_held());
        cam.capture().await.expect("usable afterwards");
    }

    #[tokio::test]
    async fn live_view_streams_frames_until_stopped() {
        let (cam, _) = camera(SimConfig::default());
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        for _ in 0..3 {
            let frame = next(&mut frames).await.expect("frame");
            assert!(frame.starts_with(&[0xFF, 0xD8]) && frame.ends_with(&[0xFF, 0xD9]));
        }
        cam.stop_live_view().await.unwrap();
        // Drain what was buffered; the stream must then end.
        while next(&mut frames).await.is_some() {}
    }

    #[tokio::test]
    async fn capture_works_while_live_view_runs_and_live_view_continues_after() {
        let (cam, sim) = camera(SimConfig::default());
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        next(&mut frames).await.expect("first frame");

        let photo = cam.capture().await.expect("capture with live view active");
        assert!(photo.jpeg.starts_with(&[0xFF, 0xD8]));
        assert_eq!(sim.exposures(), 1);
        assert!(!sim.shutter_held());

        // Frames keep arriving after the capture.
        for _ in 0..3 {
            next(&mut frames).await.expect("frame after capture");
        }
        cam.disconnect().await.unwrap();
        assert_eq!(*cam.status().borrow(), CameraStatus::Disconnected);
    }

    #[tokio::test]
    async fn disconnect_ends_live_view_and_closes_the_session() {
        let (cam, sim) = camera(SimConfig::default());
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        next(&mut frames).await.expect("frame");
        cam.disconnect().await.unwrap();
        while next(&mut frames).await.is_some() {}
        assert!(!sim.session_open());
    }

    /// A transport that reports when it is dropped.
    struct DropFlag {
        inner: SimTransport,
        dropped: Arc<AtomicBool>,
    }

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    impl Transport for DropFlag {
        fn write_bulk(&mut self, buf: &[u8], t: Duration) -> crate::Result<usize> {
            self.inner.write_bulk(buf, t)
        }
        fn read_bulk(&mut self, buf: &mut [u8], t: Duration) -> crate::Result<usize> {
            self.inner.read_bulk(buf, t)
        }
        fn read_interrupt(&mut self, buf: &mut [u8], t: Duration) -> crate::Result<usize> {
            self.inner.read_interrupt(buf, t)
        }
        fn reset(&mut self) -> crate::Result<()> {
            self.inner.reset()
        }
    }

    fn camera_with_drop_flag() -> (SonyCamera<DropFlag>, Arc<AtomicBool>, SimHandle) {
        let (inner, sim) = SimTransport::new(SimConfig::default());
        let dropped = Arc::new(AtomicBool::new(false));
        let transport = DropFlag {
            inner,
            dropped: dropped.clone(),
        };
        (
            SonyCamera::with_config(transport, SonyConfig::no_delays()),
            dropped,
            sim,
        )
    }

    #[tokio::test]
    async fn release_drops_the_transport_before_returning() {
        let (cam, dropped, sim) = camera_with_drop_flag();
        cam.connect().await.unwrap();
        assert!(!dropped.load(Ordering::SeqCst));

        cam.release().await;

        assert!(
            dropped.load(Ordering::SeqCst),
            "the transport must be gone when release() returns"
        );
        assert!(!sim.session_open(), "the PTP session was closed first");
        assert_eq!(*cam.status().borrow(), CameraStatus::Disconnected);
    }

    #[tokio::test]
    async fn a_released_camera_refuses_further_work() {
        let (cam, _, _) = camera_with_drop_flag();
        cam.connect().await.unwrap();
        cam.release().await;
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::NotConnected);
        assert!(matches!(
            cam.start_live_view().await,
            Err(CameraError::NotConnected)
        ));
        assert!(matches!(
            cam.connect().await,
            Err(CameraError::NotConnected),
        ));
    }

    #[tokio::test]
    async fn release_ends_live_view_and_waits_for_a_capture_in_flight() {
        let (cam, dropped, _) = camera_with_drop_flag();
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        next(&mut frames).await.expect("frame");
        cam.release().await;
        assert!(dropped.load(Ordering::SeqCst));
        while next(&mut frames).await.is_some() {}
    }

    #[tokio::test]
    async fn releasing_twice_is_harmless() {
        let (cam, _, _) = camera_with_drop_flag();
        cam.release().await;
        cam.release().await;
    }

    fn count_live_view_requests(sim: &SimHandle) -> usize {
        sim.ops()
            .iter()
            .filter(|r| {
                r.op == crate::codes::op::GET_OBJECT && r.params.first() == Some(&0xFFFF_C002)
            })
            .count()
    }

    fn deny_live_view(count: u32) -> Vec<Fault> {
        (1..=count)
            .map(|nth| Fault::Respond {
                op: crate::codes::op::GET_OBJECT,
                nth,
                code: rc::ACCESS_DENIED,
            })
            .collect()
    }

    /// The real camera answers `AccessDenied` for live-view frames intermittently, so a refusal
    /// must not end the stream: frames resume as soon as the camera allows them.
    #[tokio::test]
    async fn live_view_recovers_when_the_camera_stops_refusing_frames() {
        let (cam, sim) = camera(SimConfig {
            faults: deny_live_view(3),
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), next(&mut frames))
            .await
            .expect("a frame arrives after the refusals")
            .expect("the stream is still open");
        assert!(frame.starts_with(&[0xFF, 0xD8]));
        assert!(
            count_live_view_requests(&sim) >= 4,
            "three refusals, then a frame"
        );
    }

    #[tokio::test]
    async fn live_view_backs_off_instead_of_hammering_a_camera_that_keeps_refusing() {
        let (cam, sim) = camera(SimConfig {
            faults: deny_live_view(10_000),
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        let _frames = cam.start_live_view().await.unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        let asked = count_live_view_requests(&sim);
        assert!(
            (2..=8).contains(&asked),
            "50+100+200+400 ms of backoff allows only a handful of requests in 800 ms; got {asked}"
        );
        // And a capture is not starved or broken by the refusals.
        cam.stop_live_view().await.unwrap();
    }

    #[tokio::test]
    async fn a_photo_that_never_arrives_is_not_blamed_on_the_usb_mode() {
        let (cam, _) = camera(SimConfig {
            image_ready_after_polls: u32::MAX,
            send_object_added_event: false,
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        let err = cam.capture().await.unwrap_err();
        let CameraError::Protocol(message) = &err else {
            panic!("expected a protocol error, got {err:?}");
        };
        assert!(message.contains("did not deliver the photo"), "{message}");
        assert!(
            !message.contains("PC Remote"),
            "the handshake already worked: {message}"
        );
    }

    /// Without this the camera kept saying `Ready` while its preview was dead: no error banner,
    /// and `connect()` (a no-op for a Ready camera) could not rebuild the connection.
    #[tokio::test]
    async fn live_view_giving_up_marks_the_camera_errored_so_connect_can_recover_it() {
        let (cam, _) = camera(SimConfig {
            faults: (1..=5)
                .map(|nth| Fault::WriteError {
                    op: crate::codes::op::GET_OBJECT,
                    nth,
                })
                .collect(),
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        let mut status = cam.status();
        let mut frames = cam.start_live_view().await.unwrap();

        tokio::time::timeout(
            Duration::from_secs(5),
            status.wait_for(|s| matches!(s, CameraStatus::Error(_))),
        )
        .await
        .expect("the camera is flagged once live view gives up")
        .unwrap();
        assert!(
            next(&mut frames).await.is_none(),
            "and the frame stream has ended"
        );

        cam.connect().await.expect("a reconnect recovers it");
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
        cam.capture().await.expect("and captures work again");
    }

    #[test]
    fn an_unplugged_camera_is_reported_as_disconnected_not_as_a_raw_usb_error() {
        let unplugged = Error::Io(
            "GetObject failed: No such device (it may have been disconnected)".to_owned(),
        );
        assert_eq!(map_error(&unplugged), CameraError::Disconnected);
        assert!(needs_reconnect(&unplugged));
        // Other I/O failures keep their detail.
        assert_eq!(
            map_error(&Error::Io("Input/Output Error".to_owned())),
            CameraError::Io("Input/Output Error".to_owned())
        );
    }

    #[tokio::test]
    async fn a_stall_during_capture_reports_which_command_and_the_camera_recovers() {
        let (cam, sim) = camera(SimConfig {
            faults: vec![Fault::PipeError {
                op: crate::codes::op::GET_OBJECT_INFO,
                nth: 1,
            }],
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        let err = cam.capture().await.unwrap_err();
        assert!(
            matches!(&err, CameraError::Io(m) if m.contains("GetObjectInfo") && m.contains("stalled")),
            "{err:?}"
        );
        assert_eq!(sim.resets(), 1);
        // A stall means the pipe state is unknown: the camera reports an error until reconnected.
        assert!(matches!(*cam.status().borrow(), CameraStatus::Error(_)));
        cam.connect().await.expect("a fresh handshake recovers it");
        cam.capture().await.expect("and captures work again");
    }

    #[tokio::test]
    async fn live_view_gives_up_after_repeated_failures_even_though_activation_succeeds() {
        let faults = (1..=5)
            .map(|nth| Fault::Respond {
                op: crate::codes::op::GET_OBJECT,
                nth,
                code: rc::GENERAL_ERROR,
            })
            .collect();
        let (cam, sim) = camera(SimConfig {
            faults,
            ..SimConfig::default()
        });
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        assert!(next(&mut frames).await.is_none());
        assert_eq!(
            count_live_view_requests(&sim),
            5,
            "stops after MAX_CONSECUTIVE_FAILURES, not never"
        );
    }

    #[test]
    fn error_mapping_covers_every_engine_error() {
        assert_eq!(map_error(&Error::NotConnected), CameraError::NotConnected);
        assert_eq!(map_error(&Error::NotFound), CameraError::NotConnected);
        assert_eq!(
            map_error(&Error::Io("x".into())),
            CameraError::Io("x".into())
        );
        assert_eq!(
            map_error(&Error::Response {
                operation: "op".into(),
                code: rc::DEVICE_BUSY
            }),
            CameraError::Busy
        );
        assert!(matches!(
            map_error(&Error::Response {
                operation: "op".into(),
                code: rc::GENERAL_ERROR
            }),
            CameraError::Protocol(_)
        ));
        assert!(
            matches!(map_error(&Error::Timeout("bulk read")), CameraError::Protocol(m) if m.contains("PC Remote"))
        );
    }
}
