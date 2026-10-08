//! `NativeCamera`: the tablet's built-in camera as a `photobooth_core::Camera`.
//!
//! The live preview is rendered **natively** by CameraX behind the transparent WebView, so
//! `start_live_view` returns an empty frame stream — nothing travels over IPC. A capture is
//! written by CameraX to the cache dir; this reads the JPEG from that path and **deletes the
//! file**, so photos are never retained on the device (the no-retention rule) and raw bytes
//! never pass through JSON IPC.

use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use async_trait::async_trait;
use bytes::Bytes;
use photobooth_core::{
    Camera, CameraError, CameraId, CameraStatus, CapturedPhoto, FrameStream, JpegFrame,
};
use tokio::sync::watch;

use crate::models::{CaptureResponse, Facing, PermissionState, StartPreviewRequest};
use crate::PhotoboothCamera;

/// What `NativeCamera` needs from the platform. Implemented by [`PhotoboothCamera`] for real
/// and by fakes in tests. Errors are plain strings: they are shown to the operator, not matched.
#[async_trait]
pub trait NativeBackend: Send + Sync {
    async fn check_permission(&self) -> Result<PermissionState, String>;
    async fn request_permission(&self) -> Result<PermissionState, String>;
    async fn start_preview(&self, request: StartPreviewRequest) -> Result<(), String>;
    async fn stop_preview(&self) -> Result<(), String>;
    async fn capture(&self) -> Result<CaptureResponse, String>;
}

#[async_trait]
impl<R: tauri::Runtime> NativeBackend for PhotoboothCamera<R> {
    async fn check_permission(&self) -> Result<PermissionState, String> {
        self.check_permissions()
            .await
            .map(|s| s.camera)
            .map_err(|e| e.to_string())
    }

    async fn request_permission(&self) -> Result<PermissionState, String> {
        self.request_permissions()
            .await
            .map(|s| s.camera)
            .map_err(|e| e.to_string())
    }

    async fn start_preview(&self, request: StartPreviewRequest) -> Result<(), String> {
        self.cam_start_preview(request)
            .await
            .map_err(|e| e.to_string())
    }

    async fn stop_preview(&self) -> Result<(), String> {
        self.cam_stop_preview().await.map_err(|e| e.to_string())
    }

    async fn capture(&self) -> Result<CaptureResponse, String> {
        self.cam_capture().await.map_err(|e| e.to_string())
    }
}

/// Lets the app hand an `AppHandle` (cheap to clone, `'static`) to [`NativeCamera`] instead of
/// an owned handle to the plugin's managed state.
#[async_trait]
impl<R: tauri::Runtime> NativeBackend for tauri::AppHandle<R> {
    async fn check_permission(&self) -> Result<PermissionState, String> {
        crate::PhotoboothCameraExt::photobooth_camera(self)
            .check_permission()
            .await
    }

    async fn request_permission(&self) -> Result<PermissionState, String> {
        crate::PhotoboothCameraExt::photobooth_camera(self)
            .request_permission()
            .await
    }

    async fn start_preview(&self, request: StartPreviewRequest) -> Result<(), String> {
        crate::PhotoboothCameraExt::photobooth_camera(self)
            .start_preview(request)
            .await
    }

    async fn stop_preview(&self) -> Result<(), String> {
        crate::PhotoboothCameraExt::photobooth_camera(self)
            .stop_preview()
            .await
    }

    async fn capture(&self) -> Result<CaptureResponse, String> {
        crate::PhotoboothCameraExt::photobooth_camera(self)
            .capture()
            .await
    }
}

pub struct NativeCamera<B: NativeBackend + 'static> {
    backend: Arc<B>,
    /// Whether the guest should see a mirror image; read each time the preview starts so a
    /// settings change applies on the next start without rebuilding the camera.
    mirror: Arc<dyn Fn() -> bool + Send + Sync>,
    status: Arc<watch::Sender<CameraStatus>>,
    preview_running: Arc<std::sync::atomic::AtomicBool>,
}

impl<B: NativeBackend + 'static> NativeCamera<B> {
    pub fn new(backend: Arc<B>, mirror: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            backend,
            mirror: Arc::new(mirror),
            status: Arc::new(watch::channel(CameraStatus::Disconnected).0),
            preview_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn is_connected(&self) -> bool {
        matches!(
            *self.status.borrow(),
            CameraStatus::Ready | CameraStatus::Busy
        )
    }

    fn fail(&self, message: &str) -> CameraError {
        self.status
            .send_replace(CameraStatus::Error(message.to_owned()));
        CameraError::Io(message.to_owned())
    }

    async fn ensure_preview(&self) -> Result<(), CameraError> {
        use std::sync::atomic::Ordering;
        if self.preview_running.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.backend
            .start_preview(StartPreviewRequest {
                // The booth faces the guests, like the original app (`DEFAULT_FRONT_CAMERA`).
                facing: Facing::Front,
                mirror: (self.mirror)(),
                windowed: false,
            })
            .await
            .map_err(CameraError::Io)?;
        self.preview_running.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Returns a `Busy` camera to `Ready` when a capture ends or its future is dropped.
struct BusyGuard(Arc<watch::Sender<CameraStatus>>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.send_if_modified(|status| {
            if *status == CameraStatus::Busy {
                *status = CameraStatus::Ready;
                true
            } else {
                false
            }
        });
    }
}

#[async_trait]
impl<B: NativeBackend + 'static> Camera for NativeCamera<B> {
    fn id(&self) -> CameraId {
        CameraId::DEVICE
    }

    /// "Connecting" a device camera means making sure the CAMERA permission is held,
    /// prompting the operator if needed.
    async fn connect(&self) -> Result<(), CameraError> {
        if self.is_connected() {
            return Ok(());
        }
        self.status.send_replace(CameraStatus::Connecting);

        let mut state = self
            .backend
            .check_permission()
            .await
            .map_err(|e| self.fail(&e))?;
        if state != PermissionState::Granted {
            state = self
                .backend
                .request_permission()
                .await
                .map_err(|e| self.fail(&e))?;
        }
        if state != PermissionState::Granted {
            return Err(self.fail(
                "Camera permission was denied. Allow it in Settings → Apps → Photobooth → Permissions.",
            ));
        }
        self.status.send_replace(CameraStatus::Ready);
        Ok(())
    }

    async fn disconnect(&self) -> Result<(), CameraError> {
        self.stop_live_view().await?;
        self.status.send_replace(CameraStatus::Disconnected);
        Ok(())
    }

    fn status(&self) -> watch::Receiver<CameraStatus> {
        self.status.subscribe()
    }

    async fn start_live_view(&self) -> Result<FrameStream, CameraError> {
        if !self.is_connected() {
            return Err(CameraError::NotConnected);
        }
        self.ensure_preview().await?;
        // The preview is drawn natively; there is no frame stream to forward.
        Ok(Box::pin(tokio_stream::empty::<JpegFrame>()))
    }

    async fn stop_live_view(&self) -> Result<(), CameraError> {
        use std::sync::atomic::Ordering;
        if self.preview_running.swap(false, Ordering::SeqCst) {
            self.backend.stop_preview().await.map_err(CameraError::Io)?;
        }
        Ok(())
    }

    async fn capture(&self) -> Result<CapturedPhoto, CameraError> {
        let claimed = self.status.send_if_modified(|status| {
            if *status == CameraStatus::Ready {
                *status = CameraStatus::Busy;
                true
            } else {
                false
            }
        });
        if !claimed {
            return Err(match *self.status.borrow() {
                CameraStatus::Busy => CameraError::Busy,
                _ => CameraError::NotConnected,
            });
        }
        let _busy = BusyGuard(self.status.clone());

        // CameraX can only capture while its use cases are bound.
        self.ensure_preview().await?;
        let capture = self
            .backend
            .capture()
            .await
            .map_err(CameraError::CaptureFailed)?;
        let jpeg = read_and_delete(Path::new(&capture.path)).await?;
        Ok(CapturedPhoto {
            jpeg,
            width: capture.width,
            height: capture.height,
            taken_at: SystemTime::now(),
        })
    }
}

/// Reads the capture and removes the file whether or not the read succeeded.
async fn read_and_delete(path: &Path) -> Result<Bytes, CameraError> {
    let read = tokio::fs::read(path).await;
    if let Err(err) = tokio::fs::remove_file(path).await {
        tracing::warn!(path = %path.display(), %err, "could not delete the capture file");
    }
    read.map(Bytes::from)
        .map_err(|e| CameraError::CaptureFailed(format!("could not read the capture: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use futures_util::StreamExt;

    /// A scriptable stand-in for the Kotlin side.
    struct Fake {
        permission: Mutex<PermissionState>,
        grant_on_request: AtomicBool,
        calls: Mutex<Vec<String>>,
        capture: Mutex<Result<CaptureResponse, String>>,
        capture_delay: Duration,
        preview_requests: Mutex<Vec<StartPreviewRequest>>,
    }

    impl Fake {
        fn new(permission: PermissionState) -> Arc<Self> {
            Arc::new(Self {
                permission: Mutex::new(permission),
                grant_on_request: AtomicBool::new(true),
                calls: Mutex::new(Vec::new()),
                capture: Mutex::new(Err("not configured".into())),
                capture_delay: Duration::ZERO,
                preview_requests: Mutex::new(Vec::new()),
            })
        }

        fn log(&self, call: &str) {
            self.calls.lock().unwrap().push(call.to_owned());
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl NativeBackend for Fake {
        async fn check_permission(&self) -> Result<PermissionState, String> {
            self.log("check");
            Ok(*self.permission.lock().unwrap())
        }

        async fn request_permission(&self) -> Result<PermissionState, String> {
            self.log("request");
            let state = if self.grant_on_request.load(Ordering::SeqCst) {
                PermissionState::Granted
            } else {
                PermissionState::Denied
            };
            *self.permission.lock().unwrap() = state;
            Ok(state)
        }

        async fn start_preview(&self, request: StartPreviewRequest) -> Result<(), String> {
            self.log("start_preview");
            self.preview_requests.lock().unwrap().push(request);
            Ok(())
        }

        async fn stop_preview(&self) -> Result<(), String> {
            self.log("stop_preview");
            Ok(())
        }

        async fn capture(&self) -> Result<CaptureResponse, String> {
            self.log("capture");
            tokio::time::sleep(self.capture_delay).await;
            self.capture.lock().unwrap().clone()
        }
    }

    fn camera(fake: &Arc<Fake>) -> NativeCamera<Fake> {
        NativeCamera::new(fake.clone(), || true)
    }

    fn write_capture(dir: &tempfile::TempDir, bytes: &[u8]) -> CaptureResponse {
        let path = dir.path().join("capture.jpg");
        std::fs::write(&path, bytes).unwrap();
        CaptureResponse {
            path: path.to_string_lossy().into_owned(),
            width: 4000,
            height: 3000,
        }
    }

    // ----- connect / permission -------------------------------------------------------

    #[tokio::test]
    async fn a_held_permission_connects_without_prompting() {
        let fake = Fake::new(PermissionState::Granted);
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
        assert_eq!(fake.calls(), vec!["check"]);
    }

    #[tokio::test]
    async fn a_missing_permission_is_requested_and_granted() {
        let fake = Fake::new(PermissionState::Prompt);
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
        assert_eq!(fake.calls(), vec!["check", "request"]);
    }

    #[tokio::test]
    async fn a_denied_permission_fails_with_guidance() {
        let fake = Fake::new(PermissionState::Denied);
        fake.grant_on_request.store(false, Ordering::SeqCst);
        let cam = camera(&fake);
        let err = cam.connect().await.unwrap_err();
        assert!(
            matches!(&err, CameraError::Io(m) if m.contains("permission")),
            "{err}"
        );
        assert!(matches!(
            &*cam.status().borrow(),
            CameraStatus::Error(m) if m.contains("Settings")
        ));
    }

    #[tokio::test]
    async fn connect_is_idempotent_and_retries_after_a_failure() {
        let fake = Fake::new(PermissionState::Denied);
        fake.grant_on_request.store(false, Ordering::SeqCst);
        let cam = camera(&fake);
        assert!(cam.connect().await.is_err());

        // The operator grants it in system settings, then retries.
        fake.grant_on_request.store(true, Ordering::SeqCst);
        cam.connect().await.unwrap();
        let before = fake.calls().len();
        cam.connect().await.unwrap();
        assert_eq!(
            fake.calls().len(),
            before,
            "already connected: no backend calls"
        );
    }

    // ----- preview --------------------------------------------------------------------

    #[tokio::test]
    async fn live_view_starts_the_native_preview_and_streams_nothing() {
        let fake = Fake::new(PermissionState::Granted);
        let cam = NativeCamera::new(fake.clone(), || false);
        cam.connect().await.unwrap();

        let mut stream = cam.start_live_view().await.unwrap();
        assert!(
            stream.next().await.is_none(),
            "frames are drawn natively, not streamed"
        );
        let requests = fake.preview_requests.lock().unwrap().clone();
        assert_eq!(
            requests,
            vec![StartPreviewRequest {
                facing: Facing::Front,
                mirror: false,
                windowed: false
            }]
        );
    }

    #[tokio::test]
    async fn the_mirror_setting_is_read_each_time_the_preview_starts() {
        let fake = Fake::new(PermissionState::Granted);
        let mirror = Arc::new(AtomicBool::new(true));
        let cam = NativeCamera::new(fake.clone(), {
            let mirror = mirror.clone();
            move || mirror.load(Ordering::SeqCst)
        });
        cam.connect().await.unwrap();
        let _ = cam.start_live_view().await.unwrap();
        cam.stop_live_view().await.unwrap();
        mirror.store(false, Ordering::SeqCst);
        let _ = cam.start_live_view().await.unwrap();
        let mirrors: Vec<bool> = fake
            .preview_requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.mirror)
            .collect();
        assert_eq!(mirrors, [true, false]);
    }

    #[tokio::test]
    async fn starting_live_view_twice_binds_the_preview_once() {
        let fake = Fake::new(PermissionState::Granted);
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        let _ = cam.start_live_view().await.unwrap();
        let _ = cam.start_live_view().await.unwrap();
        let starts = fake
            .calls()
            .iter()
            .filter(|c| *c == "start_preview")
            .count();
        assert_eq!(starts, 1);
    }

    #[tokio::test]
    async fn live_view_requires_a_connection() {
        let fake = Fake::new(PermissionState::Granted);
        let cam = camera(&fake);
        assert!(matches!(
            cam.start_live_view().await,
            Err(CameraError::NotConnected)
        ));
    }

    #[tokio::test]
    async fn disconnect_stops_the_preview_and_stop_is_idempotent() {
        let fake = Fake::new(PermissionState::Granted);
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        let _ = cam.start_live_view().await.unwrap();
        cam.disconnect().await.unwrap();
        cam.stop_live_view().await.unwrap();
        let stops = fake.calls().iter().filter(|c| *c == "stop_preview").count();
        assert_eq!(stops, 1);
        assert_eq!(*cam.status().borrow(), CameraStatus::Disconnected);
    }

    // ----- capture --------------------------------------------------------------------

    #[tokio::test]
    async fn capture_reads_the_jpeg_and_deletes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(PermissionState::Granted);
        *fake.capture.lock().unwrap() = Ok(write_capture(&dir, &[0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]));
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        let _ = cam.start_live_view().await.unwrap();

        let photo = cam.capture().await.unwrap();
        assert_eq!(photo.jpeg.as_ref(), &[0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]);
        assert_eq!((photo.width, photo.height), (4000, 3000));
        assert!(
            !dir.path().join("capture.jpg").exists(),
            "photos must never be left on the device"
        );
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
    }

    #[tokio::test]
    async fn capture_binds_the_preview_itself_if_live_view_was_never_started() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(PermissionState::Granted);
        *fake.capture.lock().unwrap() = Ok(write_capture(&dir, b"jpeg"));
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        cam.capture().await.unwrap();
        assert_eq!(fake.calls(), vec!["check", "start_preview", "capture"]);
    }

    #[tokio::test]
    async fn a_failed_capture_is_reported_and_the_camera_stays_usable() {
        let fake = Fake::new(PermissionState::Granted);
        *fake.capture.lock().unwrap() = Err("ImageCaptureException: camera closed".into());
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        let err = cam.capture().await.unwrap_err();
        assert_eq!(
            err,
            CameraError::CaptureFailed("ImageCaptureException: camera closed".into())
        );
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
    }

    #[tokio::test]
    async fn a_missing_capture_file_is_a_capture_failure() {
        let fake = Fake::new(PermissionState::Granted);
        *fake.capture.lock().unwrap() = Ok(CaptureResponse {
            path: "/definitely/not/here.jpg".into(),
            width: 1,
            height: 1,
        });
        let cam = camera(&fake);
        cam.connect().await.unwrap();
        assert!(matches!(
            cam.capture().await,
            Err(CameraError::CaptureFailed(m)) if m.contains("could not read")
        ));
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
    }

    #[tokio::test]
    async fn capture_requires_a_connection_and_rejects_overlap() {
        let fake = Fake::new(PermissionState::Granted);
        let cam = camera(&fake);
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::NotConnected);
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_capture_while_one_runs_is_busy_and_a_dropped_one_frees_the_camera() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(PermissionState::Granted);
        Arc::get_mut(&mut fake).unwrap().capture_delay = Duration::from_secs(5);
        *fake.capture.lock().unwrap() = Ok(write_capture(&dir, b"jpeg"));
        let cam = Arc::new(camera(&fake));
        cam.connect().await.unwrap();

        let first = tokio::spawn({
            let cam = cam.clone();
            async move { cam.capture().await }
        });
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::Busy);
        first.abort();
        let _ = first.await;
        assert_eq!(
            *cam.status().borrow(),
            CameraStatus::Ready,
            "guard released the camera"
        );
    }

    #[test]
    fn identifies_as_the_device_camera() {
        let fake = Fake::new(PermissionState::Granted);
        assert_eq!(camera(&fake).id(), CameraId::DEVICE);
    }
}
