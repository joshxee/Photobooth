//! The Android open-palm recognizer as a `photobooth_core::PalmDetector`.
//!
//! The recognizer (MediaPipe) lives in Kotlin. This sends it one live-view JPEG at a time, with
//! the guest's box, and reads back where an open palm is; the hold-time decision stays in
//! `photobooth_core::gesture`.

use std::sync::Arc;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use bytes::Bytes;
use photobooth_core::{DetectorError, PalmDetector, Region};

use crate::models::FrameRegion;
use crate::PhotoboothCamera;

/// What the detector needs from the platform; implemented for real by [`PhotoboothCamera`] and
/// by fakes in tests.
#[async_trait]
pub trait GestureBackend: Send + Sync {
    /// `frame` is the JPEG, base64-encoded.
    async fn detect(
        &self,
        frame: String,
        region: FrameRegion,
    ) -> Result<Option<FrameRegion>, String>;
}

#[async_trait]
impl<R: tauri::Runtime> GestureBackend for PhotoboothCamera<R> {
    async fn detect(
        &self,
        frame: String,
        region: FrameRegion,
    ) -> Result<Option<FrameRegion>, String> {
        self.gesture_detect(frame, region)
            .await
            .map(|response| response.palm)
            .map_err(|e| e.to_string())
    }
}

/// Lets the app hand an `AppHandle` (cheap to clone, `'static`) to the detector.
#[async_trait]
impl<R: tauri::Runtime> GestureBackend for tauri::AppHandle<R> {
    async fn detect(
        &self,
        frame: String,
        region: FrameRegion,
    ) -> Result<Option<FrameRegion>, String> {
        crate::PhotoboothCameraExt::photobooth_camera(self)
            .detect(frame, region)
            .await
    }
}

pub struct NativePalmDetector<B: GestureBackend + 'static> {
    backend: Arc<B>,
}

impl<B: GestureBackend + 'static> NativePalmDetector<B> {
    pub fn new(backend: Arc<B>) -> Self {
        Self { backend }
    }
}

#[async_trait]
impl<B: GestureBackend + 'static> PalmDetector for NativePalmDetector<B> {
    async fn find_palm(
        &self,
        jpeg: Bytes,
        within: Region,
    ) -> Result<Option<Region>, DetectorError> {
        let region = FrameRegion {
            x: within.x,
            y: within.y,
            w: within.w,
            h: within.h,
        };
        let found = self
            .backend
            .detect(STANDARD.encode(&jpeg), region)
            .await
            .map_err(DetectorError)?;
        // A malformed answer from the recognizer is "no palm", not a crash.
        Ok(found.and_then(|r| Region::new(r.x, r.y, r.w, r.h)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        seen: Mutex<Vec<(String, FrameRegion)>>,
        answer: Result<Option<FrameRegion>, String>,
    }

    #[async_trait]
    impl GestureBackend for Fake {
        async fn detect(
            &self,
            frame: String,
            region: FrameRegion,
        ) -> Result<Option<FrameRegion>, String> {
            self.seen.lock().unwrap().push((frame, region));
            self.answer.clone()
        }
    }

    fn fake(answer: Result<Option<FrameRegion>, String>) -> Arc<Fake> {
        Arc::new(Fake {
            seen: Mutex::new(Vec::new()),
            answer,
        })
    }

    const BOX: Region = Region {
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.4,
    };

    #[tokio::test]
    async fn sends_the_frame_as_base64_with_the_box_and_returns_the_palm() {
        let palm = FrameRegion {
            x: 0.15,
            y: 0.25,
            w: 0.1,
            h: 0.2,
        };
        let backend = fake(Ok(Some(palm)));
        let detector = NativePalmDetector::new(backend.clone());
        let found = detector
            .find_palm(Bytes::from_static(&[0xFF, 0xD8, 0xFF, 0xD9]), BOX)
            .await
            .unwrap();
        let found = found.expect("a palm");
        assert!((found.x - 0.15).abs() < 1e-5 && (found.h - 0.2).abs() < 1e-5);
        let seen = backend.seen.lock().unwrap();
        assert_eq!(seen[0].0, "/9j/2Q==");
        assert_eq!(
            seen[0].1,
            FrameRegion {
                x: 0.1,
                y: 0.2,
                w: 0.3,
                h: 0.4
            }
        );
    }

    #[tokio::test]
    async fn no_palm_is_none() {
        let detector = NativePalmDetector::new(fake(Ok(None)));
        assert_eq!(detector.find_palm(Bytes::new(), BOX).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_palm_outside_the_frame_is_ignored() {
        let bad = FrameRegion {
            x: 0.9,
            y: 0.9,
            w: 0.5,
            h: 0.5,
        };
        let detector = NativePalmDetector::new(fake(Ok(Some(bad))));
        assert_eq!(detector.find_palm(Bytes::new(), BOX).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_backend_error_becomes_a_detector_error() {
        let detector = NativePalmDetector::new(fake(Err("model missing".to_owned())));
        let err = detector.find_palm(Bytes::new(), BOX).await.unwrap_err();
        assert_eq!(err, DetectorError("model missing".to_owned()));
    }
}
