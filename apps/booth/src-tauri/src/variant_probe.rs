//! Debug builds only: times the variant encoder (DESIGN D14) on real captures, so session 08b
//! can measure it on the tablet. Compiled only with `debug_assertions` (see `lib.rs`), so
//! release builds don't contain it. Session 10 replaces it with the real completion hook.
//!
//! Each completed session's shots are encoded one at a time on one background thread, which
//! logs a `variant probe` line per shot (`logcat -s Photobooth`, `logs_recent`) and drops the
//! output. Nothing is written to disk and no image bytes leave Rust.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use photobooth_core::variants::{encode_variants_with_report, EncodeReport, VariantError};
use photobooth_core::{CompletedSession, OnSessionComplete};

/// The outcome for one shot.
#[derive(Debug)]
pub struct ProbeRecord {
    pub session_id: String,
    pub shot: u8,
    pub input_bytes: usize,
    /// The HD size on success.
    pub result: Result<(EncodeReport, u32, u32), VariantError>,
}

pub struct VariantProbe {
    // A `Mutex` so the probe is `Sync`; `send` never blocks.
    sessions: Mutex<mpsc::Sender<CompletedSession>>,
}

impl VariantProbe {
    /// A probe that logs each shot.
    pub fn spawn() -> Arc<Self> {
        Self::spawn_with(log_record)
    }

    /// A probe that hands each shot's record to `sink`, on the probe's thread. The thread
    /// ends when the probe is dropped.
    pub fn spawn_with(sink: impl Fn(ProbeRecord) + Send + 'static) -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<CompletedSession>();
        let spawned = thread::Builder::new()
            .name("variant-probe".into())
            .spawn(move || {
                for session in rx {
                    for shot in session.shots {
                        let result = encode_variants_with_report(&shot.jpeg)
                            .map(|(out, report)| (report, out.width, out.height));
                        sink(ProbeRecord {
                            session_id: session.session_id.clone(),
                            shot: shot.shot,
                            input_bytes: shot.jpeg.len(),
                            result,
                        });
                    }
                }
            });
        if let Err(err) = spawned {
            tracing::warn!(%err, "variant probe thread did not start");
        }
        Arc::new(Self {
            sessions: Mutex::new(tx),
        })
    }
}

impl OnSessionComplete for VariantProbe {
    fn on_session_complete(&self, session: CompletedSession) {
        let sent = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(session);
        if sent.is_err() {
            tracing::warn!("variant probe is not running; session not measured");
        }
    }
}

fn ms(d: std::time::Duration) -> u128 {
    d.as_millis()
}

fn log_record(record: ProbeRecord) {
    match record.result {
        Ok((r, hd_width, hd_height)) => tracing::info!(
            session = %record.session_id,
            shot = record.shot,
            input_bytes = r.input_bytes,
            input = format_args!("{}x{}", r.input_width, r.input_height),
            orientation = r.orientation,
            decode_ms = ms(r.decode),
            resize_ms = ms(r.resize),
            orient_ms = ms(r.orient),
            encode_ms = ms(r.encode),
            total_ms = ms(r.total()),
            hd = format_args!("{hd_width}x{hd_height}"),
            hd_bytes = r.hd_bytes,
            thumb_bytes = r.thumb_bytes,
            "variant probe"
        ),
        Err(err) => tracing::warn!(
            session = %record.session_id,
            shot = record.shot,
            input_bytes = record.input_bytes,
            %err,
            "variant probe failed"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    use bytes::Bytes;
    use photobooth_core::{Camera, CameraId, CompletedShot, MockCamera, TestModeSettings};

    async fn camera_jpeg() -> Bytes {
        let camera = MockCamera::new(TestModeSettings::default());
        camera.connect().await.unwrap();
        camera.capture().await.unwrap().jpeg
    }

    fn shot(n: u8, jpeg: Bytes) -> CompletedShot {
        CompletedShot {
            shot: n,
            jpeg,
            width: 0,
            height: 0,
            taken_at: SystemTime::UNIX_EPOCH,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn each_shot_is_encoded_in_order_and_failures_are_reported() {
        let jpeg = camera_jpeg().await;
        let (tx, rx) = mpsc::channel();
        let probe = VariantProbe::spawn_with(move |r| tx.send(r).unwrap());
        probe.on_session_complete(CompletedSession {
            session_id: "abc-1".into(),
            camera: CameraId::SONY_USB,
            shots: vec![
                shot(1, jpeg.clone()),
                shot(2, Bytes::from_static(b"not a jpeg")),
                shot(3, jpeg.clone()),
            ],
        });
        let records: Vec<ProbeRecord> = (0..3)
            .map(|_| rx.recv_timeout(Duration::from_secs(30)).expect("record"))
            .collect();
        assert_eq!(
            records.iter().map(|r| r.shot).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert!(records.iter().all(|r| r.session_id == "abc-1"));
        let (report, w, h) = records[0].result.as_ref().expect("shot 1 encodes");
        assert_eq!(report.input_bytes, jpeg.len());
        assert!(w.max(h) <= &2560 && report.hd_bytes > 0 && report.thumb_bytes > 0);
        assert!(records[1].result.is_err());
        assert_eq!(records[1].input_bytes, 10);
        assert!(records[2].result.is_ok());
    }

    #[tokio::test]
    async fn the_hook_returns_without_waiting_for_the_encode() {
        let jpeg = camera_jpeg().await;
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let (tx, rx) = mpsc::channel();
        // The sink blocks until released: a hook that encoded inline could not return.
        let probe = VariantProbe::spawn_with(move |r| {
            gate_rx.recv().unwrap();
            tx.send(r).unwrap();
        });
        let (done_tx, done_rx) = mpsc::channel();
        let caller = probe.clone();
        thread::spawn(move || {
            caller.on_session_complete(CompletedSession {
                session_id: "abc-2".into(),
                camera: CameraId::SONY_USB,
                shots: vec![shot(1, jpeg)],
            });
            done_tx.send(()).unwrap();
        });
        let returned = done_rx.recv_timeout(Duration::from_secs(5));
        gate_tx.send(()).unwrap();
        assert!(
            returned.is_ok(),
            "on_session_complete blocked on the encode"
        );
        assert!(rx
            .recv_timeout(Duration::from_secs(30))
            .unwrap()
            .result
            .is_ok());
    }
}
