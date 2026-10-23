//! The upload loop: drains the outbox while the booth is enrolled (DESIGN §10 item 3).
//!
//! One loop, so one `drain_once` at a time, which is what keeps uploads at two at once. It
//! runs on its own thread with its own single-threaded runtime and HTTP client, because the
//! outbox reads variants and `fsync`s records inline (blocking) and must not hold up the
//! async workers that serve the UI.
//!
//! It wakes when a shot is queued or the operator retries one, when an item's backoff ends,
//! when the booth is enrolled or unenrolled, and at least every [`POLL`] while items wait.
//! There is no network-change hint (that needs Android's `ConnectivityManager` through the
//! plugin); instead, while the portal can't be reached, each poll brings the oldest waiting
//! item forward as a probe, and the first answer brings every item forward. So uploads
//! resume within about 30 s of the network coming back, not after a 5-minute backoff.

use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime};

use photobooth_core::outbox::PortalClient;

use super::{Uploads, Woke};
use crate::portal::client::http_client;
use crate::portal::PortalService;

/// The longest the loop sleeps while items wait.
pub const POLL: Duration = Duration::from_secs(30);

/// Wall-clock time for backoff deadlines; tests drive it from tokio's paused clock.
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// The client for the enrolled portal, read before every pass, so an unenrolment or a new
/// enrolment takes effect at once.
pub trait ClientSource: Send + Sync {
    /// `None` when the booth isn't enrolled (or its enrolment can't be used).
    fn client(&self) -> Option<Arc<dyn PortalClient>>;
}

/// The app's [`ClientSource`]: the stored credential, with an HTTP client of the loop's own.
pub struct PortalSource {
    portal: Arc<PortalService>,
    // Built on the loop's thread at first use, so its connections live on the loop's runtime.
    http: OnceLock<Result<reqwest::Client, String>>,
}

impl PortalSource {
    pub fn new(portal: Arc<PortalService>) -> Self {
        Self {
            portal,
            http: OnceLock::new(),
        }
    }
}

impl ClientSource for PortalSource {
    fn client(&self) -> Option<Arc<dyn PortalClient>> {
        let http = match self.http.get_or_init(http_client) {
            Ok(http) => http.clone(),
            Err(err) => {
                tracing::error!(err, "no HTTP client for uploads");
                return None;
            }
        };
        let client = self.portal.client_with(http).ok()?;
        Some(Arc::new(client))
    }
}

/// Runs [`run`] on a new thread with its own runtime. Returns when it has started.
pub fn spawn_loop(
    uploads: Arc<Uploads>,
    source: Arc<dyn ClientSource>,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("outbox-upload".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    tracing::error!(%err, "the upload loop has no runtime; nothing will upload");
                    return;
                }
            };
            runtime.block_on(run(uploads, source, Arc::new(SystemTime::now)));
        })
}

/// The loop itself. Returns after [`Uploads::shutdown`].
pub async fn run(uploads: Arc<Uploads>, source: Arc<dyn ClientSource>, clock: Clock) {
    tracing::info!("upload loop started");
    let outbox = uploads.outbox().clone();
    let mut offline = false;
    loop {
        if uploads.is_shut_down() {
            break;
        }
        let epoch = uploads.epoch();
        let client = if uploads.revoked_epoch() == Some(epoch) {
            None
        } else {
            source.client()
        };
        let Some(client) = client else {
            // Not enrolled, or refused: wait for an enrolment (or anything else) to change.
            offline = false;
            uploads.set_offline(false);
            if uploads.wait(None).await == Woke::Shutdown {
                break;
            }
            continue;
        };

        let pass = outbox.drain_once(client.as_ref(), clock());
        let report = tokio::select! {
            report = pass => report,
            () = uploads.stopped() => break,
        };
        if report.revoked {
            tracing::warn!(
                queued = outbox.len(),
                "the portal refused this booth's credential; uploads are paused until it is \
                 enrolled again (the queue is kept)"
            );
            uploads.set_revoked(epoch);
            continue;
        }
        let answered =
            report.ready + report.needs_attention + report.retried - report.network_failures;
        if answered > 0 {
            if offline {
                let brought = outbox.expedite_all(clock());
                tracing::info!(brought, "the portal answers again; uploads resume");
            }
            offline = false;
        } else if report.network_failures > 0 && !offline {
            tracing::info!(
                queued = outbox.len(),
                "the portal can't be reached; uploads wait"
            );
            offline = true;
        }
        uploads.set_offline(offline);

        let now = clock();
        let timeout = outbox
            .next_attempt_at()
            .map(|at| at.duration_since(now).unwrap_or_default().min(POLL));
        match uploads.wait(timeout).await {
            Woke::Shutdown => break,
            Woke::Timer if offline && outbox.next_due(clock()).is_none() => {
                // The probe: one item tries early to find out whether the portal is back.
                outbox.expedite_next(clock());
            }
            Woke::Timer | Woke::Nudged => {}
        }
    }
    tracing::info!("upload loop stopped");
}

#[cfg(test)]
mod tests {
    use super::super::tests::{encoded, open_outbox, EVENT};
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;
    use bytes::Bytes;
    use photobooth_core::outbox::{
        ErrorCode, IntentOutcome, OutboxItem, PortalError, UploadDescriptor, UploadOutcome, Variant,
    };

    /// A portal that answers each intent from a script (then PENDING for both), stores each
    /// PUT (hd answers READY), and can be switched offline. Calls take `latency`.
    #[derive(Default)]
    struct FakePortal {
        intents: Mutex<VecDeque<Result<IntentOutcome, PortalError>>>,
        offline: AtomicBool,
        latency: Duration,
        intent_calls: AtomicUsize,
        ready: Mutex<Vec<(String, String)>>,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
        hang: AtomicBool,
    }

    impl FakePortal {
        fn with_latency(ms: u64) -> Arc<Self> {
            Arc::new(Self {
                latency: Duration::from_millis(ms),
                ..Self::default()
            })
        }

        fn script(&self, answers: Vec<Result<IntentOutcome, PortalError>>) {
            *self.intents.lock().unwrap() = answers.into();
        }

        fn ready(&self) -> Vec<(String, String)> {
            self.ready.lock().unwrap().clone()
        }

        async fn call(&self) -> Result<(), PortalError> {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(self.latency).await;
            while self.hang.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            if self.offline.load(Ordering::SeqCst) {
                return Err(PortalError::Network("no route to host".into()));
            }
            Ok(())
        }
    }

    fn put(variant: Variant, id: &str, session: &str) -> UploadDescriptor {
        UploadDescriptor {
            variant,
            method: "PUT".into(),
            // The fake reads the item's IDs back from here.
            url: format!("https://fake.invalid/{id}/{session}/{variant}"),
            headers: Default::default(),
            expires_at: "2026-10-22T09:45:00.000Z".into(),
        }
    }

    #[async_trait]
    impl PortalClient for FakePortal {
        async fn intent(&self, item: &OutboxItem) -> Result<IntentOutcome, PortalError> {
            self.intent_calls.fetch_add(1, Ordering::SeqCst);
            self.call().await?;
            if let Some(answer) = self.intents.lock().unwrap().pop_front() {
                return answer;
            }
            Ok(IntentOutcome::Pending {
                uploads: Variant::ALL
                    .iter()
                    .map(|&v| put(v, &item.client_photo_id, &item.session_id))
                    .collect(),
            })
        }

        async fn upload(
            &self,
            upload: &UploadDescriptor,
            _body: Bytes,
        ) -> Result<UploadOutcome, PortalError> {
            self.call().await?;
            Ok(match upload.variant {
                Variant::Thumb => UploadOutcome::Stored,
                Variant::Hd => {
                    let parts: Vec<&str> = upload.url.rsplit('/').collect();
                    self.ready
                        .lock()
                        .unwrap()
                        .push((parts[2].to_owned(), parts[1].to_owned()));
                    UploadOutcome::Ready
                }
            })
        }
    }

    /// Enrolled or not, on the test's say.
    struct Source {
        portal: Arc<FakePortal>,
        enrolled: AtomicBool,
    }

    impl ClientSource for Source {
        fn client(&self) -> Option<Arc<dyn PortalClient>> {
            self.enrolled
                .load(Ordering::SeqCst)
                .then(|| self.portal.clone() as Arc<dyn PortalClient>)
        }
    }

    /// Wall-clock time that moves with tokio's (paused) clock.
    fn paused_clock() -> Clock {
        let start = tokio::time::Instant::now();
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_661_400);
        Arc::new(move || base + start.elapsed())
    }

    struct Rig {
        _dir: tempfile::TempDir,
        uploads: Arc<Uploads>,
        portal: Arc<FakePortal>,
        source: Arc<Source>,
        clock: Clock,
        task: tokio::task::JoinHandle<()>,
    }

    fn rig(portal: Arc<FakePortal>, enrolled: bool) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let uploads = Arc::new(Uploads::new(open_outbox(dir.path())));
        let source = Arc::new(Source {
            portal: portal.clone(),
            enrolled: AtomicBool::new(enrolled),
        });
        let clock = paused_clock();
        let task = tokio::spawn(run(uploads.clone(), source.clone(), clock.clone()));
        Rig {
            _dir: dir,
            uploads,
            portal,
            source,
            clock,
            task,
        }
    }

    impl Rig {
        fn queue(&self, session: &str, shot: u8) -> String {
            self.uploads
                .enqueue(EVENT, session, shot, (self.clock)(), encoded(shot))
                .unwrap()
                .client_photo_id
        }

        async fn settle(&self, secs: u64) {
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_queued_shot_uploads_at_once_and_is_deleted() {
        let rig = rig(FakePortal::with_latency(50), true);
        let id = rig.queue("s-1", 1);
        rig.settle(1).await;
        assert_eq!(rig.portal.ready(), vec![(id, "s-1".to_owned())]);
        assert!(rig.uploads.outbox().is_empty());
        assert_eq!(rig.uploads.status().queued, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn never_more_than_two_uploads_at_once() {
        let rig = rig(FakePortal::with_latency(200), true);
        for n in 0..12 {
            rig.queue(&format!("s-{}", n / 3), (n % 3) as u8 + 1);
            // Shots keep arriving while a pass runs.
            rig.settle(0).await;
        }
        rig.settle(30).await;
        assert_eq!(rig.portal.ready().len(), 12);
        assert_eq!(rig.portal.max_in_flight.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_uploads_while_not_enrolled_and_an_enrolment_starts_it() {
        let rig = rig(FakePortal::with_latency(10), false);
        rig.queue("s-1", 1);
        rig.settle(120).await;
        assert_eq!(rig.portal.intent_calls.load(Ordering::SeqCst), 0);
        assert_eq!(rig.uploads.status().queued, 1, "kept");

        rig.source.enrolled.store(true, Ordering::SeqCst);
        rig.uploads.enrolment_changed();
        rig.settle(1).await;
        assert_eq!(rig.portal.ready().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_revoked_device_pauses_until_it_is_enrolled_again() {
        let rig = rig(FakePortal::with_latency(10), true);
        rig.portal
            .script(vec![Err(PortalError::code(ErrorCode::Unauthorized))]);
        rig.queue("s-1", 1);
        rig.settle(1).await;
        let status = rig.uploads.status();
        assert!(status.revoked, "{status:?}");
        assert_eq!(status.queued, 1, "the item is kept, queued");
        assert_eq!(status.needs_attention, 0, "not the item's fault");

        // More shots, polls and time: nothing is tried with the refused credential.
        let calls = rig.portal.intent_calls.load(Ordering::SeqCst);
        rig.queue("s-1", 2);
        rig.settle(600).await;
        assert_eq!(rig.portal.intent_calls.load(Ordering::SeqCst), calls);
        assert!(rig.uploads.status().revoked);

        // Unenrol, enrol again: both resume.
        rig.uploads.enrolment_changed();
        rig.uploads.enrolment_changed();
        rig.settle(1).await;
        assert!(!rig.uploads.status().revoked);
        assert_eq!(rig.portal.ready().len(), 2);
        assert!(rig.uploads.outbox().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn offline_is_reported_and_uploads_resume_soon_after_the_network_returns() {
        let rig = rig(FakePortal::with_latency(10), true);
        rig.portal.offline.store(true, Ordering::SeqCst);
        for shot in 1..=3 {
            rig.queue("s-1", shot);
        }
        rig.settle(2).await;
        assert!(rig.uploads.status().offline);

        // Ten minutes offline: each item's backoff doubles towards the 5-minute cap (about
        // 10 tries each), plus at most one probe per 30 s poll. No spinning.
        let before = rig.portal.intent_calls.load(Ordering::SeqCst);
        rig.settle(600).await;
        let during = rig.portal.intent_calls.load(Ordering::SeqCst) - before;
        assert!(
            during <= 3 * 10 + 600 / 30,
            "{during} intents in 10 minutes"
        );
        assert!(rig.uploads.status().offline);
        assert_eq!(rig.uploads.status().queued, 3);

        rig.portal.offline.store(false, Ordering::SeqCst);
        rig.settle(POLL.as_secs() + 2).await;
        assert_eq!(
            rig.portal.ready().len(),
            3,
            "within one poll, not a 5-minute backoff"
        );
        assert!(!rig.uploads.status().offline);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_stops_the_loop_while_waiting_and_mid_upload() {
        let idle = rig(FakePortal::with_latency(10), true);
        idle.settle(1).await;
        idle.uploads.shutdown();
        tokio::time::timeout(Duration::from_secs(1), idle.task)
            .await
            .expect("stopped while waiting")
            .unwrap();

        let busy = rig(FakePortal::with_latency(10), true);
        busy.portal.hang.store(true, Ordering::SeqCst);
        let id = busy.queue("s-1", 1);
        busy.settle(5).await;
        assert_eq!(busy.uploads.status().uploading, 1);
        busy.uploads.shutdown();
        tokio::time::timeout(Duration::from_secs(1), busy.task)
            .await
            .expect("stopped mid-upload")
            .unwrap();
        // On disk the item is still queued; it goes at the next start.
        let reopened = open_outbox(busy._dir.path());
        assert_eq!(
            reopened.get(&id).unwrap().state,
            photobooth_core::outbox::ItemState::Queued
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_operator_retry_uploads_at_once() {
        let rig = rig(FakePortal::with_latency(10), true);
        rig.portal
            .script(vec![Err(PortalError::code(ErrorCode::EventClosed))]);
        let id = rig.queue("s-1", 1);
        rig.settle(1).await;
        assert_eq!(rig.uploads.status().needs_attention, 1);
        rig.settle(600).await;
        assert!(
            rig.portal.ready().is_empty(),
            "needs attention is never retried by itself"
        );

        rig.uploads.retry(&id).unwrap();
        rig.settle(1).await;
        assert_eq!(rig.portal.ready().len(), 1);
    }
}
