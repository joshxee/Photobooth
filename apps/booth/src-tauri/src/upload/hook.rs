//! The completed-session hook: each shot of a session that reached the review screen is
//! encoded into its two variants (08b) and queued, one shot at a time, on one background
//! thread. The hook itself only reads the selected event and hands the session over, so the
//! review screen never waits for it (DESIGN §10 item 3).
//!
//! The session already skips cancelled and failed sessions and the test camera; the test
//! camera is refused here as well. Nothing is encoded unless the booth is enrolled and an
//! event is selected. The original JPEG is never written anywhere: it arrives as the
//! session's own `Bytes` and only the variants reach the outbox.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use photobooth_core::outbox::EncodedShot;
use photobooth_core::variants::encode_variants;
use photobooth_core::{CameraId, CompletedSession, OnSessionComplete};

use super::Uploads;

/// Where completed sessions go, as the app knows it.
pub trait Destination: Send + Sync {
    /// The event selected now. Read when the session completes, on the session task, so it
    /// must be cheap (settings in memory).
    fn selected_event(&self) -> Option<String>;
    /// Whether the booth is enrolled. Read on the encoder thread (it reads a file).
    fn enrolled(&self) -> bool;
    /// `session_id`'s `shots` shots go to `event_id`. Called on the session task, so it must
    /// be cheap. Returns how long the review should stay up (for the session's QR code).
    fn handed_over(&self, session_id: &str, event_id: &str, shots: usize) -> Option<u8>;
}

/// Makes a shot's variants. A function so tests can make the encoder fail or block.
pub type Encoder = Arc<dyn Fn(&[u8]) -> Result<EncodedShot, String> + Send + Sync>;

/// The 08b encoder.
pub fn variant_encoder() -> Encoder {
    Arc::new(|jpeg| encode_variants(jpeg).map_err(|err| err.to_string()))
}

struct Job {
    session: CompletedSession,
    event_id: String,
}

pub struct EncodeAndQueue {
    destination: Arc<dyn Destination>,
    // A `Mutex` so the hook is `Sync`. Unbounded: every completed session must reach the
    // queue, and sessions arrive far slower (tens of seconds each) than they are encoded
    // (about 1.3 s for three shots on the tablet).
    jobs: Mutex<mpsc::Sender<Job>>,
}

impl EncodeAndQueue {
    /// Starts the encoder thread. It ends when the hook is dropped.
    pub fn spawn(
        uploads: Arc<Uploads>,
        destination: Arc<dyn Destination>,
        encoder: Encoder,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let worker_destination = destination.clone();
        let spawned = thread::Builder::new()
            .name("outbox-encoder".into())
            .spawn(move || {
                for job in rx {
                    encode_and_queue(&uploads, worker_destination.as_ref(), &encoder, job);
                }
            });
        if let Err(err) = spawned {
            tracing::error!(%err, "the outbox encoder thread did not start; nothing will be queued");
        }
        Arc::new(Self {
            destination,
            jobs: Mutex::new(tx),
        })
    }
}

impl OnSessionComplete for EncodeAndQueue {
    fn on_session_complete(&self, session: CompletedSession) -> Option<u8> {
        if session.camera == CameraId::TEST {
            // The session never hands these over; refuse them here too (DESIGN §10).
            tracing::debug!(session_id = %session.session_id, "test camera: not queued");
            return None;
        }
        let Some(event_id) = self.destination.selected_event() else {
            tracing::info!(
                session_id = %session.session_id,
                "no portal event selected: session not queued"
            );
            return None;
        };
        tracing::info!(
            session_id = %session.session_id,
            event_id,
            shots = session.shots.len(),
            "session handed to the outbox"
        );
        let review =
            self.destination
                .handed_over(&session.session_id, &event_id, session.shots.len());
        let sent = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(Job { session, event_id });
        if let Err(mpsc::SendError(job)) = sent {
            tracing::error!(
                session_id = %job.session.session_id,
                "the outbox encoder is not running: session not queued"
            );
            return None;
        }
        review
    }
}

fn encode_and_queue(uploads: &Uploads, destination: &dyn Destination, encoder: &Encoder, job: Job) {
    let session_id = &job.session.session_id;
    if !destination.enrolled() {
        tracing::info!(session_id = %session_id, "booth not enrolled: session not queued");
        return;
    }
    for shot in &job.session.shots {
        let started = Instant::now();
        let encoded = match encoder(&shot.jpeg) {
            Ok(encoded) => encoded,
            Err(err) => {
                tracing::warn!(
                    session_id = %session_id,
                    shot = shot.shot,
                    input_bytes = shot.jpeg.len(),
                    err,
                    "shot not queued: the variant encoder failed"
                );
                uploads.not_queued(
                    session_id,
                    shot.shot,
                    format!(
                        "Couldn't prepare this shot for upload ({err}). The camera's SD card \
                         has the original."
                    ),
                );
                continue;
            }
        };
        let encode_ms = started.elapsed().as_millis() as u64;
        match uploads.enqueue(&job.event_id, session_id, shot.shot, shot.taken_at, encoded) {
            Ok(item) => tracing::info!(
                id = %item.client_photo_id,
                session_id = %session_id,
                shot = shot.shot,
                encode_ms,
                total_ms = started.elapsed().as_millis() as u64,
                "shot encoded and queued"
            ),
            Err(err) => {
                tracing::warn!(
                    session_id = %session_id,
                    shot = shot.shot,
                    %err,
                    "shot not queued: the outbox refused it"
                );
                uploads.not_queued(
                    session_id,
                    shot.shot,
                    format!(
                        "Couldn't save this shot for upload ({err}). The camera's SD card has \
                         the original."
                    ),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{encoded, open_outbox, EVENT};
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime};

    use bytes::Bytes;
    use photobooth_core::outbox::ItemState;
    use photobooth_core::CompletedShot;

    struct Fixed {
        event: Option<String>,
        enrolled: AtomicBool,
        /// `(session, event, shots)` for each `handed_over`.
        handed: Mutex<Vec<(String, String, usize)>>,
        review: Option<u8>,
    }

    impl Destination for Fixed {
        fn selected_event(&self) -> Option<String> {
            self.event.clone()
        }
        fn enrolled(&self) -> bool {
            self.enrolled.load(Ordering::SeqCst)
        }
        fn handed_over(&self, session_id: &str, event_id: &str, shots: usize) -> Option<u8> {
            self.handed
                .lock()
                .unwrap()
                .push((session_id.to_owned(), event_id.to_owned(), shots));
            self.review
        }
    }

    fn to(event: Option<&str>, enrolled: bool) -> Arc<Fixed> {
        Arc::new(Fixed {
            event: event.map(str::to_owned),
            enrolled: AtomicBool::new(enrolled),
            handed: Mutex::new(Vec::new()),
            review: None,
        })
    }

    /// The original "camera JPEG": large and recognisable, so a test can tell it never
    /// reached the disk.
    fn original(n: u8) -> Bytes {
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend(std::iter::repeat_n(0xA0 + n, 4096));
        jpeg.extend([0xFF, 0xD9]);
        Bytes::from(jpeg)
    }

    fn session(camera: CameraId, id: &str) -> CompletedSession {
        CompletedSession {
            session_id: id.into(),
            camera,
            shots: (1..=3)
                .map(|n| CompletedShot {
                    shot: n,
                    jpeg: original(n),
                    width: 6000,
                    height: 4000,
                    taken_at: SystemTime::UNIX_EPOCH
                        + Duration::from_secs(1_792_661_400 + u64::from(n)),
                })
                .collect(),
        }
    }

    /// Encodes by tagging the input's fourth byte, counting calls; `fail` makes that shot's
    /// input fail.
    fn counting(calls: Arc<AtomicUsize>, fail: Option<u8>) -> Encoder {
        Arc::new(move |jpeg: &[u8]| {
            calls.fetch_add(1, Ordering::SeqCst);
            let n = jpeg[2] - 0xA0;
            if Some(n) == fail {
                return Err("not a baseline JPEG".into());
            }
            Ok(encoded(n))
        })
    }

    /// Waits (real time) until `cond` holds.
    fn eventually(cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn rig(
        destination: Arc<Fixed>,
        fail: Option<u8>,
    ) -> (
        tempfile::TempDir,
        Arc<Uploads>,
        Arc<EncodeAndQueue>,
        Arc<AtomicUsize>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let uploads = Arc::new(Uploads::new(open_outbox(dir.path())));
        let calls = Arc::new(AtomicUsize::new(0));
        let hook =
            EncodeAndQueue::spawn(uploads.clone(), destination, counting(calls.clone(), fail));
        (dir, uploads, hook, calls)
    }

    fn file_names(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// The post-shoot QR code (session 13) needs to know which session went to which event,
    /// and its review length comes back to the session.
    #[test]
    fn the_destination_hears_where_each_session_went_and_sets_the_review() {
        let destination = Arc::new(Fixed {
            review: Some(20),
            ..Arc::into_inner(to(Some(EVENT), true)).unwrap()
        });
        let (_dir, uploads, hook, _) = rig(destination.clone(), None);
        assert_eq!(
            hook.on_session_complete(session(CameraId::SONY_USB, "6a3f1c20-3")),
            Some(20)
        );
        assert_eq!(
            hook.on_session_complete(session(CameraId::TEST, "aa-1")),
            None
        );
        eventually(|| uploads.outbox().len() == 3);
        assert_eq!(
            *destination.handed.lock().unwrap(),
            [("6a3f1c20-3".to_owned(), EVENT.to_owned(), 3)],
            "the test camera's session is never handed over"
        );

        let (_dir, _, hook, _) = rig(to(None, true), None);
        assert_eq!(
            hook.on_session_complete(session(CameraId::SONY_USB, "bb-1")),
            None,
            "no event, no QR"
        );
    }

    #[test]
    fn every_shot_is_encoded_and_queued_to_the_selected_event() {
        let (dir, uploads, hook, _) = rig(to(Some(EVENT), true), None);
        hook.on_session_complete(session(CameraId::SONY_USB, "6a3f1c20-3"));
        eventually(|| uploads.outbox().len() == 3);

        let items = uploads.outbox().items();
        assert_eq!(items.iter().map(|i| i.shot).collect::<Vec<_>>(), [1, 2, 3]);
        for item in &items {
            assert_eq!(item.event_id, EVENT);
            assert_eq!(item.session_id, "6a3f1c20-3");
            assert_eq!(item.state, ItemState::Queued);
            assert_eq!(
                item.captured_at,
                SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_661_400 + u64::from(item.shot))
            );
            assert_eq!((item.width, item.height), (2560, 1707), "the HD's own size");
        }
        // Only variants and records on disk, never an original.
        for name in file_names(dir.path()) {
            assert!(
                name.ends_with(".thumb.jpg")
                    || name.ends_with(".hd.jpg")
                    || name.ends_with(".json"),
                "{name}"
            );
            let bytes = std::fs::read(dir.path().join(&name)).unwrap();
            assert!(bytes.len() < 1000, "{name} is {} bytes", bytes.len());
        }
    }

    #[test]
    fn test_mode_is_never_encoded_or_queued() {
        let (dir, uploads, hook, calls) = rig(to(Some(EVENT), true), None);
        hook.on_session_complete(session(CameraId::TEST, "aa-1"));
        // A real session afterwards shows the worker ran past the test one.
        hook.on_session_complete(session(CameraId::DEVICE, "aa-2"));
        eventually(|| uploads.outbox().len() == 3);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(uploads
            .outbox()
            .items()
            .iter()
            .all(|i| i.session_id == "aa-2"));
        assert_eq!(file_names(dir.path()).len(), 9);
    }

    #[test]
    fn nothing_is_encoded_without_an_event_or_an_enrolment() {
        let (_dir, uploads, hook, calls) = rig(to(None, true), None);
        hook.on_session_complete(session(CameraId::SONY_USB, "bb-1"));
        let (_dir2, uploads2, hook2, calls2) = rig(to(Some(EVENT), false), None);
        hook2.on_session_complete(session(CameraId::SONY_USB, "bb-2"));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(
            calls.load(Ordering::SeqCst) + calls2.load(Ordering::SeqCst),
            0
        );
        assert!(uploads.outbox().is_empty() && uploads2.outbox().is_empty());
        assert!(uploads.entries().is_empty() && uploads2.entries().is_empty());
    }

    #[test]
    fn an_encode_error_is_shown_once_and_the_other_shots_still_go() {
        let (_dir, uploads, hook, _) = rig(to(Some(EVENT), true), Some(2));
        hook.on_session_complete(session(CameraId::SONY_USB, "cc-1"));
        eventually(|| uploads.outbox().len() == 2 && !uploads.entries().is_empty());
        thread::sleep(Duration::from_millis(50));
        let shots: Vec<u8> = uploads.outbox().items().iter().map(|i| i.shot).collect();
        assert_eq!(shots, [1, 3]);
        let entries = uploads.entries();
        assert_eq!(entries.len(), 1, "one notice for the one failure");
        assert_eq!(
            (entries[0].session_id.as_deref(), entries[0].shot),
            (Some("cc-1"), Some(2))
        );
        assert!(entries[0].reason.contains("not a baseline JPEG"));
        assert!(entries[0].reason.contains("SD card"));
    }

    #[test]
    fn the_hook_returns_without_waiting_for_the_encoder() {
        let dir = tempfile::tempdir().unwrap();
        let uploads = Arc::new(Uploads::new(open_outbox(dir.path())));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let blocking: Encoder = Arc::new(move |_| {
            release_rx.lock().unwrap().recv().unwrap();
            Ok(encoded(1))
        });
        let hook = EncodeAndQueue::spawn(uploads.clone(), to(Some(EVENT), true), blocking);
        let started = Instant::now();
        hook.on_session_complete(session(CameraId::SONY_USB, "dd-1"));
        hook.on_session_complete(session(CameraId::SONY_USB, "dd-2"));
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "on_session_complete waited for the encoder"
        );
        for _ in 0..6 {
            release_tx.send(()).unwrap();
        }
        eventually(|| uploads.outbox().len() == 6);
    }

    #[test]
    fn the_real_encoder_makes_valid_variants() {
        // Session 08b's encoder, end to end through the hook, on a real camera JPEG.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let jpeg = rt.block_on(async {
            use photobooth_core::{Camera, MockCamera, TestModeSettings};
            let camera = MockCamera::new(TestModeSettings::default());
            camera.connect().await.unwrap();
            camera.capture().await.unwrap().jpeg
        });
        let dir = tempfile::tempdir().unwrap();
        let uploads = Arc::new(Uploads::new(open_outbox(dir.path())));
        let hook = EncodeAndQueue::spawn(uploads.clone(), to(Some(EVENT), true), variant_encoder());
        let mut completed = session(CameraId::SONY_USB, "ee-1");
        completed.shots.truncate(1);
        completed.shots[0].jpeg = jpeg.clone();
        hook.on_session_complete(completed);
        eventually(|| uploads.outbox().len() == 1);
        let item = &uploads.outbox().items()[0];
        let hd = uploads
            .outbox()
            .read_variant(&item.client_photo_id, photobooth_core::outbox::Variant::Hd)
            .unwrap();
        assert_eq!(&hd[..2], &[0xFF, 0xD8]);
        assert_ne!(hd, jpeg, "the HD is re-encoded, not the original");
    }
}
