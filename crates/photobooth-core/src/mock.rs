//! `MockCamera`: the real, in-memory backend for "test mode". It is used in the shipped app
//! (selected like any other camera), not just in unit tests, so flows can be exercised
//! deterministically without hardware.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::{mpsc, watch};
use tokio::time::{interval, sleep, MissedTickBehavior};
use tokio_stream::wrappers::ReceiverStream;

use crate::camera::{
    Camera, CameraError, CameraId, CameraStatus, CapturedPhoto, FrameStream, JpegFrame,
};
use crate::settings::TestModeSettings;

/// Interval between live-view frames (~15 fps).
pub const LIVE_FRAME_INTERVAL: Duration = Duration::from_millis(65);
/// Simulated time `connect()` takes, so the `Connecting` state is observable.
pub const CONNECT_DELAY: Duration = Duration::from_millis(100);

const LIVE_WIDTH: usize = 320;
const LIVE_HEIGHT: usize = 180;
const CAPTURE_WIDTH: usize = 960;
const CAPTURE_HEIGHT: usize = 640;

/// One-shot faults armed through [`MockCameraHandle`]; each is consumed by the next capture.
#[derive(Default)]
struct Faults {
    fail_next: bool,
    slow_next_ms: Option<u32>,
}

struct Inner {
    status_tx: watch::Sender<CameraStatus>,
    config: Mutex<TestModeSettings>,
    faults: Mutex<Faults>,
    captures: AtomicU32,
    live_stop: Mutex<Option<watch::Sender<bool>>>,
}

impl Inner {
    // None of these locks is held across an await or while running user code, so poisoning
    // can only follow a panic in trivial field access; recover rather than propagate.
    fn lock<'a, T>(m: &'a Mutex<T>) -> MutexGuard<'a, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn stop_live_view(&self) {
        if let Some(stop) = Self::lock(&self.live_stop).take() {
            let _ = stop.send(true);
        }
    }

    fn set_status(&self, status: CameraStatus) {
        self.status_tx.send_replace(status);
    }
}

/// Resets `Busy` to `Ready` when a capture ends — normally, by error, or because the
/// future was dropped (e.g. the session was cancelled mid-capture).
struct BusyGuard(Arc<Inner>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.status_tx.send_if_modified(|status| {
            if *status == CameraStatus::Busy {
                *status = CameraStatus::Ready;
                true
            } else {
                false
            }
        });
    }
}

/// The in-memory test camera.
pub struct MockCamera {
    inner: Arc<Inner>,
}

/// Fault-injection and configuration hooks for a [`MockCamera`], cheap to clone and hand to
/// a UI dev panel.
#[derive(Clone)]
pub struct MockCameraHandle {
    inner: Arc<Inner>,
}

impl MockCamera {
    pub fn new(config: TestModeSettings) -> Self {
        let (status_tx, _) = watch::channel(CameraStatus::Disconnected);
        Self {
            inner: Arc::new(Inner {
                status_tx,
                config: Mutex::new(config),
                faults: Mutex::new(Faults::default()),
                captures: AtomicU32::new(0),
                live_stop: Mutex::new(None),
            }),
        }
    }

    pub fn handle(&self) -> MockCameraHandle {
        MockCameraHandle {
            inner: self.inner.clone(),
        }
    }
}

impl MockCameraHandle {
    /// The next capture fails with `CaptureFailed`; later captures are unaffected.
    pub fn force_fail_next_capture(&self) {
        Inner::lock(&self.inner.faults).fail_next = true;
    }

    /// The next capture takes `ms` instead of the configured delay; later captures are
    /// unaffected (this does not touch the persistent setting).
    pub fn force_slow_next_capture(&self, ms: u32) {
        Inner::lock(&self.inner.faults).slow_next_ms = Some(ms);
    }

    /// Simulates the camera being unplugged: status becomes `Disconnected`, live view ends,
    /// and any in-flight capture fails. Call `connect()` to bring it back.
    pub fn force_disconnect(&self) {
        self.inner.stop_live_view();
        self.inner.set_status(CameraStatus::Disconnected);
    }

    /// Replaces the persistent test-mode settings (delay, fail cadence, pattern).
    pub fn set_config(&self, config: TestModeSettings) {
        *Inner::lock(&self.inner.config) = config;
    }

    /// Number of capture attempts so far, including failed ones.
    pub fn captures_attempted(&self) -> u32 {
        self.inner.captures.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Camera for MockCamera {
    fn id(&self) -> CameraId {
        CameraId::TEST
    }

    async fn connect(&self) -> Result<(), CameraError> {
        let needs_connect = self.inner.status_tx.send_if_modified(|status| {
            if matches!(status, CameraStatus::Ready | CameraStatus::Busy) {
                false
            } else {
                *status = CameraStatus::Connecting;
                true
            }
        });
        if needs_connect {
            sleep(CONNECT_DELAY).await;
            // A force_disconnect() during the delay wins; don't resurrect the camera.
            self.inner.status_tx.send_if_modified(|status| {
                if *status == CameraStatus::Connecting {
                    *status = CameraStatus::Ready;
                    true
                } else {
                    false
                }
            });
        }
        Ok(())
    }

    async fn disconnect(&self) -> Result<(), CameraError> {
        self.inner.stop_live_view();
        self.inner.set_status(CameraStatus::Disconnected);
        Ok(())
    }

    fn status(&self) -> watch::Receiver<CameraStatus> {
        self.inner.status_tx.subscribe()
    }

    async fn start_live_view(&self) -> Result<FrameStream, CameraError> {
        if !matches!(
            *self.inner.status_tx.borrow(),
            CameraStatus::Ready | CameraStatus::Busy
        ) {
            return Err(CameraError::NotConnected);
        }
        self.inner.stop_live_view();
        let (frames_tx, frames_rx) = mpsc::channel::<JpegFrame>(2);
        let (stop_tx, mut stop_rx) = watch::channel(false);
        *Inner::lock(&self.inner.live_stop) = Some(stop_tx);
        tokio::spawn(async move {
            let mut ticker = interval(LIVE_FRAME_INTERVAL);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut index = 0u64;
            loop {
                tokio::select! {
                    _ = ticker.tick() => {}
                    // Either an explicit stop or the sender being replaced/dropped.
                    _ = stop_rx.changed() => break,
                    () = frames_tx.closed() => break,
                }
                let frame = live_frame(index);
                index += 1;
                // A slow consumer loses frames instead of backing the producer up.
                if let Err(mpsc::error::TrySendError::Closed(_)) = frames_tx.try_send(frame) {
                    break;
                }
            }
        });
        Ok(Box::pin(ReceiverStream::new(frames_rx)))
    }

    async fn stop_live_view(&self) -> Result<(), CameraError> {
        self.inner.stop_live_view();
        Ok(())
    }

    async fn capture(&self) -> Result<CapturedPhoto, CameraError> {
        let claimed = self.inner.status_tx.send_if_modified(|status| {
            if *status == CameraStatus::Ready {
                *status = CameraStatus::Busy;
                true
            } else {
                false
            }
        });
        if !claimed {
            return Err(match *self.inner.status_tx.borrow() {
                CameraStatus::Busy => CameraError::Busy,
                _ => CameraError::NotConnected,
            });
        }
        let _busy = BusyGuard(self.inner.clone());

        let attempt = self.inner.captures.fetch_add(1, Ordering::SeqCst) + 1;
        let config = Inner::lock(&self.inner.config).clone();
        let (fail_next, slow_next_ms) = {
            let mut faults = Inner::lock(&self.inner.faults);
            (
                std::mem::take(&mut faults.fail_next),
                faults.slow_next_ms.take(),
            )
        };

        sleep(Duration::from_millis(
            slow_next_ms.unwrap_or(config.capture_delay_ms).into(),
        ))
        .await;

        if *self.inner.status_tx.borrow() != CameraStatus::Busy {
            return Err(CameraError::Disconnected);
        }
        if fail_next {
            return Err(CameraError::CaptureFailed(
                "injected failure (force_fail_next_capture)".to_owned(),
            ));
        }
        if config.fail_every_n > 0 && attempt % config.fail_every_n == 0 {
            return Err(CameraError::CaptureFailed(format!(
                "injected failure (every {} captures)",
                config.fail_every_n
            )));
        }

        Ok(CapturedPhoto {
            jpeg: capture_image(&config.pattern, attempt),
            width: CAPTURE_WIDTH as u32,
            height: CAPTURE_HEIGHT as u32,
            taken_at: SystemTime::now(),
        })
    }
}

// ---------------------------------------------------------------------------------------
// Image synthesis. Pure functions so they are trivially testable.
// ---------------------------------------------------------------------------------------

type Rgb = [u8; 3];

const PALETTE: [Rgb; 6] = [
    [0xE5, 0x39, 0x35],
    [0xFB, 0x8C, 0x00],
    [0xFD, 0xD8, 0x35],
    [0x43, 0xA0, 0x47],
    [0x1E, 0x88, 0xE5],
    [0x8E, 0x24, 0xAA],
];

/// Colour shown for live-view frame `index`: changes once per second.
pub fn live_colour(index: u64) -> Rgb {
    let second = index * LIVE_FRAME_INTERVAL.as_millis() as u64 / 1000;
    PALETTE[(second % PALETTE.len() as u64) as usize]
}

/// A small solid-colour JPEG with the frame counter drawn on it.
pub fn live_frame(index: u64) -> JpegFrame {
    let mut canvas = Canvas::new(LIVE_WIDTH, LIVE_HEIGHT, live_colour(index));
    canvas.draw_label(index, 16, 16, 5);
    canvas.encode(70)
}

/// The fixed-pattern JPEG a mock capture returns; `n` (the capture attempt number) is drawn
/// on it so shots in a strip can be told apart.
pub fn capture_image(pattern: &str, n: u32) -> Bytes {
    let mut canvas = Canvas::new(CAPTURE_WIDTH, CAPTURE_HEIGHT, [0, 0, 0]);
    match pattern {
        "checker" => canvas.fill_with(|x, y| {
            if (x / 80 + y / 80) % 2 == 0 {
                [0xEE, 0xEE, 0xEE]
            } else {
                [0x22, 0x22, 0x22]
            }
        }),
        "gradient" => canvas.fill_with(|x, y| {
            [
                (x * 255 / CAPTURE_WIDTH) as u8,
                (y * 255 / CAPTURE_HEIGHT) as u8,
                (255 - (x + y) * 255 / (CAPTURE_WIDTH + CAPTURE_HEIGHT)) as u8,
            ]
        }),
        _ => canvas.fill_with(|x, _| PALETTE[x * PALETTE.len() / CAPTURE_WIDTH]),
    }
    canvas.draw_label(
        u64::from(n),
        CAPTURE_WIDTH / 2 - 60,
        CAPTURE_HEIGHT / 2 - 40,
        16,
    );
    canvas.encode(85)
}

struct Canvas {
    width: usize,
    height: usize,
    rgb: Vec<u8>,
}

impl Canvas {
    fn new(width: usize, height: usize, colour: Rgb) -> Self {
        let mut rgb = Vec::with_capacity(width * height * 3);
        for _ in 0..width * height {
            rgb.extend_from_slice(&colour);
        }
        Self { width, height, rgb }
    }

    fn fill_with(&mut self, pixel: impl Fn(usize, usize) -> Rgb) {
        for y in 0..self.height {
            for x in 0..self.width {
                let i = (y * self.width + x) * 3;
                self.rgb[i..i + 3].copy_from_slice(&pixel(x, y));
            }
        }
    }

    fn rect(&mut self, x0: usize, y0: usize, w: usize, h: usize, colour: Rgb) {
        for y in y0..(y0 + h).min(self.height) {
            for x in x0..(x0 + w).min(self.width) {
                let i = (y * self.width + x) * 3;
                self.rgb[i..i + 3].copy_from_slice(&colour);
            }
        }
    }

    /// Draws `value` in decimal on a black plate, `scale` pixels per font dot.
    fn draw_label(&mut self, value: u64, x: usize, y: usize, scale: usize) {
        let digits: Vec<usize> = value
            .to_string()
            .bytes()
            .map(|b| usize::from(b - b'0'))
            .collect();
        let advance = 6 * scale;
        let pad = scale * 2;
        self.rect(
            x.saturating_sub(pad),
            y.saturating_sub(pad),
            digits.len() * advance + pad,
            7 * scale + 2 * pad,
            [0, 0, 0],
        );
        for (n, digit) in digits.into_iter().enumerate() {
            for (row, bits) in DIGITS[digit].iter().enumerate() {
                for col in 0..5 {
                    if bits & (0b10000 >> col) != 0 {
                        self.rect(
                            x + n * advance + col * scale,
                            y + row * scale,
                            scale,
                            scale,
                            [0xFF, 0xFF, 0xFF],
                        );
                    }
                }
            }
        }
    }

    fn encode(&self, quality: u8) -> Bytes {
        let mut out = Vec::new();
        jpeg_encoder::Encoder::new(&mut out, quality)
            .encode(
                &self.rgb,
                self.width as u16,
                self.height as u16,
                jpeg_encoder::ColorType::Rgb,
            )
            .expect("encoding an in-memory RGB buffer of valid size cannot fail");
        Bytes::from(out)
    }
}

/// 5x7 digit glyphs; each row's low 5 bits are the pixels, MSB leftmost.
const DIGITS: [[u8; 7]; 10] = [
    [
        0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
    ],
    [
        0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
    ],
    [
        0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
    ],
    [
        0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
    ],
    [
        0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
    ],
    [
        0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
    ],
];

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use tokio::time::Instant;

    fn camera() -> (MockCamera, MockCameraHandle) {
        let cam = MockCamera::new(TestModeSettings::default());
        let handle = cam.handle();
        (cam, handle)
    }

    fn decode(jpeg: &[u8]) -> (jpeg_decoder::ImageInfo, Vec<u8>) {
        let mut decoder = jpeg_decoder::Decoder::new(jpeg);
        let pixels = decoder.decode().expect("valid JPEG");
        (decoder.info().expect("info"), pixels)
    }

    fn is_jpeg(bytes: &[u8]) -> bool {
        bytes.starts_with(&[0xFF, 0xD8]) && bytes.ends_with(&[0xFF, 0xD9])
    }

    #[tokio::test(start_paused = true)]
    async fn connect_walks_through_connecting_to_ready() {
        let (cam, _) = camera();
        let mut status = cam.status();
        assert_eq!(*status.borrow(), CameraStatus::Disconnected);
        let started = Instant::now();
        cam.connect().await.unwrap();
        assert_eq!(*status.borrow_and_update(), CameraStatus::Ready);
        assert_eq!(started.elapsed(), CONNECT_DELAY);
    }

    #[tokio::test(start_paused = true)]
    async fn connect_is_idempotent() {
        let (cam, _) = camera();
        cam.connect().await.unwrap();
        let started = Instant::now();
        cam.connect().await.unwrap();
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn capture_requires_a_connection() {
        let (cam, _) = camera();
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::NotConnected);
        assert!(matches!(
            cam.start_live_view().await,
            Err(CameraError::NotConnected)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn capture_takes_the_configured_delay_and_returns_a_valid_jpeg() {
        let cam = MockCamera::new(TestModeSettings {
            capture_delay_ms: 750,
            ..TestModeSettings::default()
        });
        cam.connect().await.unwrap();
        let started = Instant::now();
        let photo = cam.capture().await.unwrap();
        assert_eq!(started.elapsed(), Duration::from_millis(750));
        assert!(is_jpeg(&photo.jpeg));
        let (info, _) = decode(&photo.jpeg);
        assert_eq!(
            (u32::from(info.width), u32::from(info.height)),
            (photo.width, photo.height)
        );
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
    }

    #[tokio::test(start_paused = true)]
    async fn status_is_busy_while_capturing() {
        let (cam, _) = camera();
        cam.connect().await.unwrap();
        let cam = Arc::new(cam);
        let task = tokio::spawn({
            let cam = cam.clone();
            async move { cam.capture().await }
        });
        tokio::task::yield_now().await;
        assert_eq!(*cam.status().borrow(), CameraStatus::Busy);
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::Busy);
        task.await.unwrap().unwrap();
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_a_capture_future_releases_the_camera() {
        let (cam, _) = camera();
        cam.connect().await.unwrap();
        {
            let capture = cam.capture();
            let _ = tokio::time::timeout(Duration::from_millis(10), capture).await;
        }
        assert_eq!(*cam.status().borrow(), CameraStatus::Ready);
        cam.capture().await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn force_fail_next_capture_is_one_shot() {
        let (cam, handle) = camera();
        cam.connect().await.unwrap();
        handle.force_fail_next_capture();
        assert!(matches!(
            cam.capture().await,
            Err(CameraError::CaptureFailed(_))
        ));
        cam.capture().await.expect("second capture succeeds");
    }

    #[tokio::test(start_paused = true)]
    async fn force_slow_next_capture_is_one_shot_and_leaves_the_setting_alone() {
        let (cam, handle) = camera();
        cam.connect().await.unwrap();
        handle.force_slow_next_capture(5_000);

        let started = Instant::now();
        cam.capture().await.unwrap();
        assert_eq!(started.elapsed(), Duration::from_millis(5_000));

        let started = Instant::now();
        cam.capture().await.unwrap();
        assert_eq!(
            started.elapsed(),
            Duration::from_millis(u64::from(TestModeSettings::default().capture_delay_ms))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn fail_every_n_fails_on_the_nth_attempt() {
        let cam = MockCamera::new(TestModeSettings {
            fail_every_n: 3,
            ..TestModeSettings::default()
        });
        cam.connect().await.unwrap();
        let outcomes: Vec<bool> = {
            let mut v = Vec::new();
            for _ in 0..6 {
                v.push(cam.capture().await.is_ok());
            }
            v
        };
        assert_eq!(outcomes, [true, true, false, true, true, false]);
    }

    #[tokio::test(start_paused = true)]
    async fn set_config_changes_behaviour_for_later_captures() {
        let (cam, handle) = camera();
        cam.connect().await.unwrap();
        handle.set_config(TestModeSettings {
            capture_delay_ms: 10,
            ..TestModeSettings::default()
        });
        let started = Instant::now();
        cam.capture().await.unwrap();
        assert_eq!(started.elapsed(), Duration::from_millis(10));
    }

    #[tokio::test(start_paused = true)]
    async fn force_disconnect_fails_an_in_flight_capture_and_blocks_new_ones() {
        let (cam, handle) = camera();
        cam.connect().await.unwrap();
        let cam = Arc::new(cam);
        let task = tokio::spawn({
            let cam = cam.clone();
            async move { cam.capture().await }
        });
        tokio::task::yield_now().await;
        handle.force_disconnect();
        assert_eq!(task.await.unwrap().unwrap_err(), CameraError::Disconnected);
        assert_eq!(*cam.status().borrow(), CameraStatus::Disconnected);
        assert_eq!(cam.capture().await.unwrap_err(), CameraError::NotConnected);

        cam.connect().await.unwrap();
        cam.capture().await.expect("works again after reconnect");
    }

    #[tokio::test(start_paused = true)]
    async fn live_view_runs_at_about_15_fps_with_valid_jpegs() {
        let (cam, _) = camera();
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        let started = Instant::now();
        let mut count = 0;
        while started.elapsed() < Duration::from_secs(1) {
            let frame = frames.next().await.expect("stream stays open");
            assert!(is_jpeg(&frame));
            count += 1;
        }
        assert!((14..=17).contains(&count), "got {count} frames in 1s");
    }

    #[tokio::test(start_paused = true)]
    async fn live_view_colour_changes_each_second_and_frames_carry_a_counter() {
        let (cam, _) = camera();
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        let first = frames.next().await.unwrap();
        // Skip ahead more than a second of frames.
        let mut later = first.clone();
        for _ in 0..17 {
            later = frames.next().await.unwrap();
        }
        let (info, a) = decode(&first);
        assert_eq!((info.width, info.height), (320, 180));
        let (_, b) = decode(&later);
        // Compare a pixel far from the counter plate (bottom-right).
        let probe = ((180 - 10) * 320 + 300) * 3;
        assert_ne!(
            a[probe..probe + 3],
            b[probe..probe + 3],
            "colour must cycle"
        );
        assert_ne!(first, later);
        assert_ne!(live_colour(0), live_colour(16));
    }

    #[tokio::test(start_paused = true)]
    async fn stop_live_view_ends_the_stream() {
        let (cam, _) = camera();
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        frames.next().await.unwrap();
        cam.stop_live_view().await.unwrap();
        // Drain whatever was already buffered; the stream must then terminate.
        while frames.next().await.is_some() {}
    }

    #[tokio::test(start_paused = true)]
    async fn force_disconnect_ends_live_view() {
        let (cam, handle) = camera();
        cam.connect().await.unwrap();
        let mut frames = cam.start_live_view().await.unwrap();
        frames.next().await.unwrap();
        handle.force_disconnect();
        while frames.next().await.is_some() {}
    }

    #[tokio::test(start_paused = true)]
    async fn restarting_live_view_replaces_the_previous_stream() {
        let (cam, _) = camera();
        cam.connect().await.unwrap();
        let mut old = cam.start_live_view().await.unwrap();
        let mut new = cam.start_live_view().await.unwrap();
        while old.next().await.is_some() {}
        assert!(new.next().await.is_some());
    }

    #[test]
    fn capture_patterns_are_distinct_and_numbered() {
        let bars = capture_image("bars", 1);
        let checker = capture_image("checker", 1);
        let gradient = capture_image("gradient", 1);
        assert_ne!(bars, checker);
        assert_ne!(bars, gradient);
        assert_ne!(checker, gradient);
        assert_ne!(capture_image("bars", 1), capture_image("bars", 2));
        assert_eq!(
            capture_image("bars", 7),
            capture_image("bars", 7),
            "deterministic"
        );
        assert!(is_jpeg(&bars) && is_jpeg(&checker) && is_jpeg(&gradient));
    }
}
