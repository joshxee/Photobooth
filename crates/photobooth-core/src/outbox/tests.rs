//! Outbox behaviour: durability on disk, recovery on open, and the drain against a scripted
//! portal (DESIGN §9.3, §10 item 3).

use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use bytes::Bytes;
use sha2::{Digest, Sha256};

use super::*;

const EVENT_A: &str = "019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01";
const EVENT_B: &str = "019a0b6d-2e10-7b4f-8d52-6c3e9f102b02";

fn t(secs: u64) -> SystemTime {
    time::from_unix_millis(1_792_661_400_000 + secs * 1000)
}

fn shot(seed: u8) -> EncodedShot {
    EncodedShot {
        thumb: vec![0xFF, 0xD8, seed, 1, 0xFF, 0xD9],
        hd: vec![0xFF, 0xD8, seed, 2, 2, 2, 0xFF, 0xD9],
        width: 2560,
        height: 1707,
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct FakeDisk(AtomicU64);

impl DiskSpace for FakeDisk {
    fn free_bytes(&self, _dir: &Path) -> io::Result<u64> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

fn options() -> OutboxOptions {
    OutboxOptions {
        jitter: Arc::new(FixedJitter(1.0)),
        disk: Arc::new(FakeDisk(AtomicU64::new(50_000_000_000))),
    }
}

fn open(dir: &Path) -> Outbox {
    Outbox::open_with(dir, options()).unwrap()
}

fn enqueue(outbox: &Outbox, seed: u8, captured: u64) -> OutboxItem {
    outbox
        .enqueue(EVENT_A, "6a3f1c20-3", seed, t(captured), shot(seed))
        .unwrap()
}

fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn needs_attention(item: &OutboxItem) -> &str {
    match &item.state {
        ItemState::NeedsAttention { reason } => reason,
        other => panic!("expected needs attention, got {other:?}"),
    }
}

// ----- enqueue and the files on disk ---------------------------------------------------

#[test]
fn enqueue_writes_both_variants_and_the_record() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let item = enqueue(&outbox, 2, 0);
    let id = &item.client_photo_id;

    assert!(item::is_contract_id(id), "lowercase UUID: {id}");
    assert_eq!(
        files(dir.path()),
        vec![
            format!("{id}.hd.jpg"),
            format!("{id}.json"),
            format!("{id}.thumb.jpg"),
        ]
    );
    let encoded = shot(2);
    assert_eq!(
        fs::read(dir.path().join(format!("{id}.thumb.jpg"))).unwrap(),
        encoded.thumb
    );
    assert_eq!(
        fs::read(dir.path().join(format!("{id}.hd.jpg"))).unwrap(),
        encoded.hd
    );
    assert_eq!(item.thumb.sha256, hex_sha256(&encoded.thumb));
    assert_eq!(item.hd.sha256, hex_sha256(&encoded.hd));
    assert_eq!(item.thumb.bytes, encoded.thumb.len() as u64);
    assert_eq!(item.hd.bytes, encoded.hd.len() as u64);
    assert_eq!((item.width, item.height), (2560, 1707));
    assert_eq!(item.event_id, EVENT_A);
    assert_eq!(item.session_id, "6a3f1c20-3");
    assert_eq!(item.shot, 2);
    assert_eq!(item.state, ItemState::Queued);
    assert_eq!(item.attempts, 0);
    assert_eq!(outbox.next_due(t(0)).unwrap(), item, "due at once");
}

#[test]
fn each_enqueue_gets_a_fresh_id() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let a = enqueue(&outbox, 1, 0);
    let b = enqueue(&outbox, 1, 0);
    assert_ne!(a.client_photo_id, b.client_photo_id);
    assert_eq!(outbox.items().len(), 2);
}

#[test]
fn enqueue_rejects_identifiers_outside_the_contract() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let bad_event = outbox.enqueue("not-a-uuid", "s-1", 1, t(0), shot(1));
    assert!(matches!(bad_event, Err(OutboxError::Invalid(_))));
    let bad_session = outbox.enqueue(EVENT_A, "has space", 1, t(0), shot(1));
    assert!(matches!(bad_session, Err(OutboxError::Invalid(_))));
    let empty = outbox.enqueue(
        EVENT_A,
        "s-1",
        1,
        t(0),
        EncodedShot {
            hd: Vec::new(),
            ..shot(1)
        },
    );
    assert!(matches!(empty, Err(OutboxError::Invalid(_))));
    assert!(files(dir.path()).is_empty(), "nothing written");
}

#[test]
fn open_creates_the_directory() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("files").join("outbox");
    let outbox = open(&nested);
    assert!(nested.is_dir());
    assert_eq!(outbox.dir(), nested);
}

// ----- restart and recovery ------------------------------------------------------------

#[test]
fn restart_preserves_the_queue() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let first = enqueue(&outbox, 1, 0);
    let second = enqueue(&outbox, 2, 1);
    outbox
        .mark_retry(&second.client_photo_id, "HTTP 503", None, t(10))
        .unwrap();
    let second = outbox.get(&second.client_photo_id).unwrap();
    drop(outbox);

    let reopened = open(dir.path());
    assert_eq!(reopened.items(), vec![first, second.clone()]);
    assert_eq!(second.attempts, 1);
    assert_eq!(second.last_error.as_deref(), Some("HTTP 503"));
}

#[test]
fn an_item_uploading_when_the_app_died_comes_back_queued() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let item = enqueue(&outbox, 1, 0);
    // Even if a record somehow says uploading, nothing is uploading after a restart.
    let path = dir.path().join(item.record_file_name());
    let json = fs::read_to_string(&path).unwrap();
    fs::write(
        &path,
        json.replace(r#""kind":"queued""#, r#""kind":"uploading""#),
    )
    .unwrap();

    let reopened = open(dir.path());
    assert_eq!(
        reopened.get(&item.client_photo_id).unwrap().state,
        ItemState::Queued
    );
}

/// A kill during a write leaves a `.tmp` file; only a rename commits, so the temp file is
/// never a complete item and is deleted on open.
#[test]
fn temp_files_left_by_a_kill_mid_write_are_deleted_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let kept = enqueue(&outbox, 1, 0);
    drop(outbox);
    let orphan = "5f0c2b1e-8d3a-4c6f-9b2e-7a1d4e6f8c90";
    fs::write(dir.path().join(format!("{orphan}.thumb.jpg.tmp")), b"half").unwrap();
    // A record update interrupted mid-write: the old record is still in place.
    fs::write(
        dir.path()
            .join(format!("{}.json.tmp", kept.client_photo_id)),
        b"{",
    )
    .unwrap();

    let reopened = open(dir.path());
    assert_eq!(reopened.items(), vec![kept.clone()]);
    assert!(reopened.quarantined().is_empty());
    assert!(files(dir.path()).iter().all(|f| !f.ends_with(".tmp")));
}

#[test]
fn a_record_with_a_missing_variant_needs_attention() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let item = enqueue(&outbox, 1, 0);
    drop(outbox);
    fs::remove_file(
        dir.path()
            .join(Variant::Hd.file_name(&item.client_photo_id)),
    )
    .unwrap();

    let reopened = open(dir.path());
    let found = reopened.get(&item.client_photo_id).unwrap();
    assert!(needs_attention(&found).contains("hd"), "{found:?}");
    assert_eq!(
        reopened.next_due(t(1000)),
        None,
        "never retried automatically"
    );
    // The thumb and the record are kept.
    assert_eq!(files(dir.path()).len(), 2);
    // Stable across another restart.
    let again = open(dir.path());
    assert!(matches!(
        again.get(&item.client_photo_id).unwrap().state,
        ItemState::NeedsAttention { .. }
    ));
}

/// The enqueue writes the variants first and the record last, so a kill in between leaves
/// variants without a record: quarantined, never deleted.
#[test]
fn variants_without_a_record_are_quarantined() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let item = enqueue(&outbox, 1, 0);
    drop(outbox);
    fs::remove_file(dir.path().join(item.record_file_name())).unwrap();

    let reopened = open(dir.path());
    assert!(reopened.items().is_empty());
    let quarantined = reopened.quarantined();
    assert_eq!(quarantined.len(), 1);
    assert_eq!(quarantined[0].id, item.client_photo_id);
    assert!(quarantined[0].reason.contains("record"));
    assert_eq!(quarantined[0].files.len(), 2);
    assert_eq!(files(dir.path()).len(), 2, "nothing deleted");
    assert_eq!(reopened.stats().needs_attention, 1);

    // Retry is impossible without a record; dismiss removes the files.
    assert!(reopened.retry(&item.client_photo_id).is_err());
    reopened.dismiss(&item.client_photo_id).unwrap();
    assert!(files(dir.path()).is_empty());
    assert!(reopened.quarantined().is_empty());
}

#[test]
fn an_unreadable_record_is_quarantined_with_its_files() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let item = enqueue(&outbox, 1, 0);
    drop(outbox);
    fs::write(dir.path().join(item.record_file_name()), b"{ not json").unwrap();

    let reopened = open(dir.path());
    let quarantined = reopened.quarantined();
    assert_eq!(quarantined.len(), 1);
    assert!(
        quarantined[0].reason.contains("unreadable"),
        "{quarantined:?}"
    );
    assert_eq!(quarantined[0].files.len(), 3);
    assert_eq!(files(dir.path()).len(), 3);
}

#[test]
fn unrelated_files_are_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("README.txt"), b"hi").unwrap();
    let outbox = open(dir.path());
    assert!(outbox.items().is_empty());
    assert!(outbox.quarantined().is_empty());
    assert_eq!(files(dir.path()), vec!["README.txt"]);
}

// ----- state transitions ---------------------------------------------------------------

#[test]
fn ready_deletes_all_three_files() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let keep = enqueue(&outbox, 1, 0);
    let done = enqueue(&outbox, 2, 0);
    outbox.mark_ready(&done.client_photo_id).unwrap();
    assert!(outbox.get(&done.client_photo_id).is_none());
    assert!(files(dir.path())
        .iter()
        .all(|f| f.starts_with(&keep.client_photo_id)));
    assert_eq!(files(dir.path()).len(), 3);
    assert_eq!(open(dir.path()).items(), vec![keep]);
}

#[test]
fn retry_backs_off_exponentially_up_to_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let mut delays = Vec::new();
    for _ in 0..12 {
        let next = outbox.mark_retry(&id, "HTTP 503", None, t(0)).unwrap();
        delays.push(next.duration_since(t(0)).unwrap().as_secs());
    }
    assert_eq!(
        delays,
        vec![1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]
    );
    let item = outbox.get(&id).unwrap();
    assert_eq!(item.attempts, 12);
    assert_eq!(item.state, ItemState::Queued);
    assert_eq!(outbox.next_due(t(299)), None);
    assert_eq!(outbox.next_due(t(300)).unwrap().client_photo_id, id);
    assert_eq!(outbox.next_attempt_at(), Some(t(300)));
}

#[test]
fn retry_after_is_honoured() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let next = outbox
        .mark_retry(
            &id,
            "rate_limited (429)",
            Some(Duration::from_secs(90)),
            t(0),
        )
        .unwrap();
    assert_eq!(next, t(90), "longer than the 1 s backoff");
    assert_eq!(outbox.next_due(t(89)), None);
}

#[test]
fn needs_attention_retry_and_dismiss() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    outbox.mark_retry(&id, "HTTP 503", None, t(0)).unwrap();
    outbox
        .mark_needs_attention(&id, "event_closed (409)")
        .unwrap();
    assert_eq!(outbox.next_due(t(10_000)), None);
    assert_eq!(
        needs_attention(&open(dir.path()).get(&id).unwrap()),
        "event_closed (409)",
        "persisted"
    );

    outbox.retry(&id).unwrap();
    let item = outbox.get(&id).unwrap();
    assert_eq!(item.state, ItemState::Queued);
    assert_eq!(item.attempts, 0, "a manual retry starts the backoff again");
    assert_eq!(outbox.next_due(t(0)).unwrap().client_photo_id, id);

    outbox.dismiss(&id).unwrap();
    assert!(outbox.get(&id).is_none());
    assert!(files(dir.path()).is_empty());
}

#[test]
fn unknown_ids_are_errors() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = "5f0c2b1e-8d3a-4c6f-9b2e-7a1d4e6f8c90";
    assert!(matches!(
        outbox.mark_ready(id),
        Err(OutboxError::UnknownItem(_))
    ));
    assert!(matches!(outbox.retry(id), Err(OutboxError::UnknownItem(_))));
    assert!(matches!(
        outbox.dismiss("../x"),
        Err(OutboxError::UnknownItem(_))
    ));
}

#[test]
fn reading_a_variant_checks_its_hash() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let item = enqueue(&outbox, 1, 0);
    let id = &item.client_photo_id;
    assert_eq!(
        outbox.read_variant(id, Variant::Hd).unwrap(),
        Bytes::from(shot(1).hd)
    );
    fs::write(dir.path().join(Variant::Hd.file_name(id)), b"bitrot").unwrap();
    assert!(matches!(
        outbox.read_variant(id, Variant::Hd),
        Err(OutboxError::Corrupt(_))
    ));
}

// ----- stats ---------------------------------------------------------------------------

#[test]
fn stats_count_states_and_report_low_disk() {
    let dir = tempfile::tempdir().unwrap();
    let disk = Arc::new(FakeDisk(AtomicU64::new(5_000_000_000)));
    let outbox = Outbox::open_with(
        dir.path(),
        OutboxOptions {
            disk: disk.clone(),
            ..options()
        },
    )
    .unwrap();
    let a = enqueue(&outbox, 1, 0).client_photo_id;
    enqueue(&outbox, 2, 0);
    enqueue(&outbox, 3, 0);
    outbox.mark_needs_attention(&a, "forbidden (403)").unwrap();

    let stats = outbox.stats();
    assert_eq!(
        (stats.queued, stats.uploading, stats.needs_attention),
        (2, 0, 1)
    );
    assert_eq!(stats.free_bytes, Some(5_000_000_000));
    assert!(!stats.low_disk);

    disk.0.store(LOW_DISK_BYTES - 1, Ordering::SeqCst);
    let stats = outbox.stats();
    assert_eq!(stats.free_bytes, Some(LOW_DISK_BYTES - 1));
    assert!(stats.low_disk, "warn the operator below 1 GB");
}

#[test]
fn unknown_free_space_is_not_reported_as_low() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = Outbox::open(dir.path()).unwrap();
    let stats = outbox.stats();
    assert_eq!(stats.free_bytes, None);
    assert!(!stats.low_disk);
}

// ----- the drain -----------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
enum Call {
    Intent { id: String, event_id: String },
    Upload { variant: Variant, body: Bytes },
}

/// A portal that answers from scripts (then from defaults: intent → both variants pending,
/// upload → stored for thumb and READY for hd) and records every call.
#[derive(Default)]
struct ScriptedPortal {
    intents: Mutex<VecDeque<Result<IntentOutcome, PortalError>>>,
    uploads: Mutex<VecDeque<Result<UploadOutcome, PortalError>>>,
    calls: Mutex<Vec<Call>>,
    /// Each call takes this long (tokio time), so concurrent items overlap.
    latency: Duration,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

fn pending(variants: &[Variant]) -> IntentOutcome {
    IntentOutcome::Pending {
        uploads: variants
            .iter()
            .map(|&variant| UploadDescriptor {
                variant,
                method: "PUT".into(),
                url: format!("https://photos.example.invalid/v1/device/uploads/p/{variant}"),
                headers: [("Content-Type".to_owned(), "image/jpeg".to_owned())].into(),
                expires_at: "2026-10-22T09:45:00.000Z".into(),
            })
            .collect(),
    }
}

impl ScriptedPortal {
    fn with_latency(latency: Duration) -> Self {
        Self {
            latency,
            ..Self::default()
        }
    }

    fn intents(self, script: Vec<Result<IntentOutcome, PortalError>>) -> Self {
        *self.intents.lock().unwrap() = script.into();
        self
    }

    fn uploads(self, script: Vec<Result<UploadOutcome, PortalError>>) -> Self {
        *self.uploads.lock().unwrap() = script.into();
        self
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn uploaded_variants(&self) -> Vec<Variant> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c {
                Call::Upload { variant, .. } => Some(variant),
                Call::Intent { .. } => None,
            })
            .collect()
    }

    fn intent_count(&self) -> usize {
        self.calls()
            .iter()
            .filter(|c| matches!(c, Call::Intent { .. }))
            .count()
    }

    async fn busy(&self) {
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(self.latency).await;
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl PortalClient for ScriptedPortal {
    async fn intent(&self, item: &OutboxItem) -> Result<IntentOutcome, PortalError> {
        self.calls.lock().unwrap().push(Call::Intent {
            id: item.client_photo_id.clone(),
            event_id: item.event_id.clone(),
        });
        self.busy().await;
        let scripted = self.intents.lock().unwrap().pop_front();
        scripted.unwrap_or_else(|| Ok(pending(&Variant::ALL)))
    }

    async fn upload(
        &self,
        upload: &UploadDescriptor,
        body: Bytes,
    ) -> Result<UploadOutcome, PortalError> {
        self.calls.lock().unwrap().push(Call::Upload {
            variant: upload.variant,
            body,
        });
        self.busy().await;
        let scripted = self.uploads.lock().unwrap().pop_front();
        scripted.unwrap_or(Ok(match upload.variant {
            Variant::Thumb => UploadOutcome::Stored,
            Variant::Hd => UploadOutcome::Ready,
        }))
    }
}

#[tokio::test]
async fn a_full_upload_sends_both_variants_then_deletes_the_files() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let item = enqueue(&outbox, 7, 0);
    let portal = ScriptedPortal::default();

    let report = outbox.drain_once(&portal, t(0)).await;

    assert_eq!(
        report,
        DrainReport {
            ready: 1,
            ..DrainReport::default()
        }
    );
    assert_eq!(
        portal.calls(),
        vec![
            Call::Intent {
                id: item.client_photo_id.clone(),
                event_id: EVENT_A.into()
            },
            Call::Upload {
                variant: Variant::Thumb,
                body: Bytes::from(shot(7).thumb)
            },
            Call::Upload {
                variant: Variant::Hd,
                body: Bytes::from(shot(7).hd)
            },
        ]
    );
    assert!(outbox.items().is_empty());
    assert!(files(dir.path()).is_empty());
}

#[tokio::test]
async fn an_intent_answered_ready_uploads_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    enqueue(&outbox, 1, 0);
    let portal = ScriptedPortal::default().intents(vec![Ok(IntentOutcome::Ready)]);
    outbox.drain_once(&portal, t(0)).await;
    assert!(portal.uploaded_variants().is_empty());
    assert!(files(dir.path()).is_empty());
}

#[tokio::test]
async fn an_intent_returning_only_the_hd_url_uploads_only_hd() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    enqueue(&outbox, 1, 0);
    let portal = ScriptedPortal::default().intents(vec![Ok(pending(&[Variant::Hd]))]);
    let report = outbox.drain_once(&portal, t(0)).await;
    assert_eq!(portal.uploaded_variants(), vec![Variant::Hd]);
    assert_eq!(report.ready, 1);
    assert!(files(dir.path()).is_empty());
}

#[tokio::test]
async fn an_intent_answered_rejected_needs_attention() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let portal = ScriptedPortal::default().intents(vec![Ok(IntentOutcome::Rejected {
        reason: "segment 0xe1 not allowed".into(),
    })]);
    let report = outbox.drain_once(&portal, t(0)).await;
    assert_eq!(report.needs_attention, 1);
    let item = outbox.get(&id).unwrap();
    assert!(needs_attention(&item).contains("segment 0xe1 not allowed"));
    assert!(portal.uploaded_variants().is_empty());
    assert_eq!(files(dir.path()).len(), 3, "variants kept for the operator");
}

/// What one error, answered to the first intent or upload, does to the item.
#[derive(Debug, PartialEq, Eq)]
enum Expect {
    /// Back to the queue with backoff (`attempts` 1).
    Retry,
    /// Stopped, with the error as the reason.
    Attention,
    /// The device was refused: the pass stops and the item waits, untouched, for a new
    /// enrolment (`attempts` 0, still due).
    Paused,
}

/// DESIGN §9.3, one row at a time, answered to the intent and then to an upload.
#[tokio::test]
async fn each_error_row_of_the_design_table() {
    use ErrorCode::*;
    let rows: Vec<(&str, PortalError, Expect)> = vec![
        (
            "network",
            PortalError::Network("reset".into()),
            Expect::Retry,
        ),
        ("429", PortalError::code(RateLimited), Expect::Retry),
        ("500", PortalError::code(Internal), Expect::Retry),
        ("502 without a body", http(502), Expect::Retry),
        ("401", PortalError::code(Unauthorized), Expect::Paused),
        ("401 without a body", http(401), Expect::Paused),
        ("403", PortalError::code(Forbidden), Expect::Attention),
        (
            "event_closed",
            PortalError::code(EventClosed),
            Expect::Attention,
        ),
        (
            "photo_limit",
            PortalError::code(PhotoLimit),
            Expect::Attention,
        ),
        (
            "invalid_image",
            PortalError::code(InvalidImage),
            Expect::Attention,
        ),
        ("conflict", PortalError::code(Conflict), Expect::Attention),
    ];
    for (name, error, expect) in rows {
        for at_upload in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let outbox = open(dir.path());
            let id = enqueue(&outbox, 1, 0).client_photo_id;
            let portal = if at_upload {
                ScriptedPortal::default().uploads(vec![Err(error.clone())])
            } else {
                ScriptedPortal::default().intents(vec![Err(error.clone())])
            };
            let report = outbox.drain_once(&portal, t(0)).await;

            let item = outbox.get(&id).unwrap();
            let case = format!("{name} at {}", if at_upload { "upload" } else { "intent" });
            assert_eq!(report.revoked, expect == Expect::Paused, "{case}");
            match expect {
                Expect::Retry => {
                    assert_eq!(item.state, ItemState::Queued, "{case}");
                    assert_eq!(item.attempts, 1, "{case}");
                    assert!(item.next_attempt_at > t(0), "{case}");
                    assert_eq!(item.last_error, Some(error.to_string()), "{case}");
                }
                Expect::Attention => {
                    assert_eq!(needs_attention(&item), error.to_string(), "{case}");
                    assert_eq!(outbox.next_due(t(100_000)), None, "{case}");
                }
                Expect::Paused => {
                    assert_eq!(item.state, ItemState::Queued, "{case}");
                    assert_eq!(item.attempts, 0, "{case}");
                    assert_eq!(outbox.next_due(t(0)), Some(item.clone()), "{case}");
                    assert_eq!(item.last_error, None, "{case}");
                }
            }
            assert_eq!(files(dir.path()).len(), 3, "{case}: files kept");
        }
    }
}

fn http(status: u16) -> PortalError {
    PortalError::Http {
        status,
        code: None,
        retry_after: None,
    }
}

#[tokio::test]
async fn a_202_processing_answer_is_retried() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let portal = ScriptedPortal::default().uploads(vec![
        Ok(UploadOutcome::Stored),
        Ok(UploadOutcome::Processing { retry_after: None }),
    ]);
    let report = outbox.drain_once(&portal, t(0)).await;
    assert_eq!(report.retried, 1);
    let item = outbox.get(&id).unwrap();
    assert_eq!(item.state, ItemState::Queued);
    assert_eq!(item.attempts, 1);
}

#[tokio::test]
async fn an_expired_upload_url_re_posts_the_intent_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let portal = ScriptedPortal::default()
        .intents(vec![
            Ok(pending(&Variant::ALL)),
            Ok(pending(&[Variant::Hd])),
        ])
        .uploads(vec![
            Ok(UploadOutcome::Stored),
            Err(PortalError::code(ErrorCode::UploadExpired)),
        ]);
    let report = outbox.drain_once(&portal, t(0)).await;
    assert_eq!(report.ready, 1);
    assert_eq!(portal.intent_count(), 2, "same clientPhotoId, fresh URL");
    assert_eq!(
        portal.uploaded_variants(),
        vec![Variant::Thumb, Variant::Hd, Variant::Hd]
    );
    assert!(outbox.get(&id).is_none());
}

#[tokio::test]
async fn upload_urls_that_keep_expiring_fall_back_to_backoff() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let expired = || Err(PortalError::code(ErrorCode::UploadExpired));
    let portal = ScriptedPortal::default().uploads(vec![expired(), expired(), expired()]);
    let report = outbox.drain_once(&portal, t(0)).await;
    assert_eq!(report.retried, 1);
    assert_eq!(portal.intent_count(), MAX_INTENTS_PER_ATTEMPT);
    assert_eq!(outbox.get(&id).unwrap().state, ItemState::Queued);
}

#[tokio::test]
async fn hash_mismatch_is_retried_three_times_then_needs_attention() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let mismatch = || Err(PortalError::code(ErrorCode::HashMismatch));
    let portal =
        ScriptedPortal::default().uploads(vec![mismatch(), mismatch(), mismatch(), mismatch()]);
    let mut now = t(0);
    for retry in 1..=3 {
        outbox.drain_once(&portal, now).await;
        let item = outbox.get(&id).unwrap();
        assert_eq!(item.state, ItemState::Queued, "retry {retry}");
        assert_eq!(item.hash_mismatches, retry);
        now = item.next_attempt_at;
    }
    outbox.drain_once(&portal, now).await;
    let item = outbox.get(&id).unwrap();
    assert_eq!(needs_attention(&item), "hash_mismatch (422)");
    assert_eq!(portal.uploaded_variants().len(), 4);
}

#[tokio::test]
async fn a_retry_after_from_the_server_sets_the_next_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let portal = ScriptedPortal::default().intents(vec![Err(PortalError::Http {
        status: 429,
        code: Some(ErrorCode::RateLimited),
        retry_after: Some(Duration::from_secs(120)),
    })]);
    outbox.drain_once(&portal, t(0)).await;
    assert_eq!(outbox.get(&id).unwrap().next_attempt_at, t(120));

    // Not due before then: the next drain does nothing.
    outbox.drain_once(&portal, t(119)).await;
    assert_eq!(portal.intent_count(), 1);
    outbox.drain_once(&portal, t(120)).await;
    assert!(outbox.get(&id).is_none());
}

#[tokio::test]
async fn a_corrupted_variant_file_needs_attention_without_uploading() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    fs::write(dir.path().join(Variant::Thumb.file_name(&id)), b"bitrot").unwrap();
    let portal = ScriptedPortal::default();
    outbox.drain_once(&portal, t(0)).await;
    assert!(needs_attention(&outbox.get(&id).unwrap()).contains("thumb"));
    assert!(portal.uploaded_variants().is_empty());
}

#[tokio::test(start_paused = true)]
async fn at_most_two_items_upload_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    for seed in 0..6 {
        enqueue(&outbox, seed, u64::from(seed));
    }
    let portal = ScriptedPortal::with_latency(Duration::from_millis(200));

    let drain = outbox.drain_once(&portal, t(10));
    let stats_during = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        outbox.stats()
    };
    let (report, during) = tokio::join!(drain, stats_during);

    assert_eq!(report.ready, 6);
    assert_eq!(portal.max_in_flight.load(Ordering::SeqCst), 2);
    assert_eq!((during.uploading, during.queued), (2, 4));
    assert!(outbox.items().is_empty());
}

#[tokio::test]
async fn items_go_oldest_capture_first() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let late = enqueue(&outbox, 1, 50).client_photo_id;
    let early = enqueue(&outbox, 2, 10).client_photo_id;
    assert_eq!(outbox.next_due(t(100)).unwrap().client_photo_id, early);
    let portal = ScriptedPortal::default();
    outbox.drain_once(&portal, t(100)).await;
    let order: Vec<String> = portal
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            Call::Intent { id, .. } => Some(id),
            Call::Upload { .. } => None,
        })
        .collect();
    assert_eq!(order, vec![early, late]);
}

#[tokio::test]
async fn needs_attention_items_are_never_drained() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    outbox.mark_needs_attention(&id, "forbidden (403)").unwrap();
    let portal = ScriptedPortal::default();
    let report = outbox.drain_once(&portal, t(100_000)).await;
    assert_eq!(report, DrainReport::default());
    assert!(portal.calls().is_empty());
}

#[tokio::test]
async fn switching_events_keeps_old_items_on_their_event() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let old = outbox
        .enqueue(EVENT_A, "aa-1", 1, t(0), shot(1))
        .unwrap()
        .client_photo_id;
    // The operator selects another event; new shots go there.
    let new = outbox
        .enqueue(EVENT_B, "aa-2", 1, t(5), shot(2))
        .unwrap()
        .client_photo_id;
    drop(outbox);

    let outbox = open(dir.path());
    assert_eq!(outbox.get(&old).unwrap().event_id, EVENT_A);
    assert_eq!(outbox.get(&new).unwrap().event_id, EVENT_B);
    let portal = ScriptedPortal::default();
    outbox.drain_once(&portal, t(10)).await;
    let intents: Vec<Call> = portal
        .calls()
        .into_iter()
        .filter(|c| matches!(c, Call::Intent { .. }))
        .collect();
    assert_eq!(
        intents,
        vec![
            Call::Intent {
                id: old,
                event_id: EVENT_A.into()
            },
            Call::Intent {
                id: new,
                event_id: EVENT_B.into()
            },
        ]
    );
}

#[tokio::test]
async fn the_intent_carries_the_contract_fields() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let captured = time::from_unix_millis(1_792_661_412_345);
    let item = outbox
        .enqueue(EVENT_A, "6a3f1c20-3", 2, captured, shot(2))
        .unwrap();
    assert_eq!(item.captured_at_iso(), "2026-10-22T09:30:12.345Z");
    assert!(item::is_contract_id(&item.client_photo_id));
    assert_eq!(item.thumb.sha256.len(), 64);
    assert!(item
        .thumb
        .sha256
        .bytes()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
}

#[test]
fn the_operator_cannot_retry_or_dismiss_an_item_that_is_uploading() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let claimed = outbox.claim_due(t(0)).unwrap();
    assert_eq!(claimed.state, ItemState::Uploading);

    assert!(matches!(outbox.retry(&id), Err(OutboxError::WrongState(_))));
    assert!(matches!(
        outbox.dismiss(&id),
        Err(OutboxError::WrongState(_))
    ));
    assert_eq!(outbox.get(&id).unwrap().state, ItemState::Uploading);
    assert_eq!(files(dir.path()).len(), 3, "nothing deleted mid-upload");
    assert_eq!(outbox.claim_due(t(0)), None, "not claimable twice");
}

#[test]
fn retry_only_applies_to_items_that_need_attention() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let next = outbox.mark_retry(&id, "HTTP 503", None, t(0)).unwrap();
    // A queued item keeps its backoff: a stale "retry" tap must not reset it.
    assert!(matches!(outbox.retry(&id), Err(OutboxError::WrongState(_))));
    let item = outbox.get(&id).unwrap();
    assert_eq!((item.attempts, item.next_attempt_at), (1, next));
}

#[tokio::test]
async fn a_transient_read_error_is_retried_not_stopped() {
    // A variant that vanished is corruption (needs attention); other I/O errors are not.
    // Simulate one by replacing the variant file with a directory (read fails, not NotFound).
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let path = dir.path().join(Variant::Thumb.file_name(&id));
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let portal = ScriptedPortal::default();
    let report = outbox.drain_once(&portal, t(0)).await;
    assert_eq!(report.retried, 1);
    assert_eq!(outbox.get(&id).unwrap().state, ItemState::Queued);
}

#[tokio::test]
async fn a_202_passes_on_its_retry_after() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let id = enqueue(&outbox, 1, 0).client_photo_id;
    let portal = ScriptedPortal::default().uploads(vec![Ok(UploadOutcome::Processing {
        retry_after: Some(Duration::from_secs(45)),
    })]);
    outbox.drain_once(&portal, t(0)).await;
    assert_eq!(outbox.get(&id).unwrap().next_attempt_at, t(45));
}

// ----- session 10: the upload loop's inputs ----------------------------------------------

/// A revoked device (401 on the intent or a PUT) stops the pass: nothing more is tried with
/// that credential, and every item stays queued and due, so a new enrolment resumes them.
#[tokio::test(start_paused = true)]
async fn a_revoked_device_stops_the_pass_and_keeps_every_item_queued() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let ids: Vec<String> = (0..5)
        .map(|seed| enqueue(&outbox, seed, u64::from(seed)).client_photo_id)
        .collect();
    let portal = ScriptedPortal::with_latency(Duration::from_millis(10)).intents(vec![
        Err(
            PortalError::code(ErrorCode::Unauthorized)
        );
        5
    ]);

    let report = outbox.drain_once(&portal, t(0)).await;

    assert!(report.revoked);
    assert_eq!(
        (report.ready, report.retried, report.needs_attention),
        (0, 0, 0)
    );
    assert!(
        portal.intent_count() <= MAX_CONCURRENT_UPLOADS,
        "no new item is tried after the refusal: {} intents",
        portal.intent_count()
    );
    for id in &ids {
        let item = outbox.get(id).unwrap();
        assert_eq!((item.state.clone(), item.attempts), (ItemState::Queued, 0));
    }
    assert_eq!(outbox.stats().queued, 5);
    assert_eq!(files(dir.path()).len(), 15, "every file kept");
}

#[tokio::test]
async fn network_failures_are_counted_apart_from_other_retries() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    enqueue(&outbox, 1, 0);
    enqueue(&outbox, 2, 1);
    let portal = ScriptedPortal::default().intents(vec![
        Err(PortalError::Network("no route to host".into())),
        Err(PortalError::code(ErrorCode::Internal)),
    ]);
    let report = outbox.drain_once(&portal, t(0)).await;
    assert_eq!(report.retried, 2);
    assert_eq!(report.network_failures, 1);
    assert!(!report.revoked);
}

/// `subscribe` is how the app learns that `stats()` may have changed, uploads included.
#[test]
fn every_state_change_is_announced() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let mut changes = outbox.subscribe();
    let mut fired = || {
        let changed = changes.has_changed().unwrap();
        changes.mark_unchanged();
        changed
    };
    assert!(!fired());

    let id = enqueue(&outbox, 1, 0).client_photo_id;
    assert!(fired(), "enqueue");
    outbox.mark_retry(&id, "HTTP 503", None, t(0)).unwrap();
    assert!(fired(), "retry scheduled");
    outbox.mark_needs_attention(&id, "conflict (409)").unwrap();
    assert!(fired(), "needs attention");
    outbox.retry(&id).unwrap();
    assert!(fired(), "operator retry");
    let _ = outbox.stats();
    assert!(!fired(), "reading changes nothing");
    assert!(outbox.claim_due(t(0)).is_some());
    assert!(fired(), "claimed for upload");
    outbox.mark_ready(&id).unwrap();
    assert!(fired(), "ready");

    let other = enqueue(&outbox, 2, 1).client_photo_id;
    fired();
    outbox.dismiss(&other).unwrap();
    assert!(fired(), "dismissed");
    assert!(outbox.retry(&other).is_err());
    assert!(!fired(), "a refused call changes nothing");
}

#[test]
fn len_counts_every_item_not_yet_ready() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    assert_eq!(outbox.len(), 0);
    let a = enqueue(&outbox, 1, 0).client_photo_id;
    enqueue(&outbox, 2, 1);
    outbox.mark_needs_attention(&a, "conflict (409)").unwrap();
    assert_eq!(outbox.len(), 2);
}

/// The loop's connectivity probe: after an offline spell it brings the oldest waiting item
/// forward, and once the portal answers again, all of them.
#[test]
fn expedite_brings_queued_items_forward() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = open(dir.path());
    let old = enqueue(&outbox, 1, 0).client_photo_id;
    let new = enqueue(&outbox, 2, 5).client_photo_id;
    let stuck = enqueue(&outbox, 3, 9).client_photo_id;
    for id in [&old, &new] {
        for _ in 0..8 {
            outbox
                .mark_retry(id, "network error: offline", None, t(0))
                .unwrap();
        }
    }
    outbox
        .mark_needs_attention(&stuck, "conflict (409)")
        .unwrap();
    assert_eq!(outbox.next_due(t(10)), None, "both backing off");

    assert!(outbox.expedite_next(t(10)));
    assert_eq!(outbox.next_due(t(10)).unwrap().client_photo_id, old);
    assert!(outbox.get(&new).unwrap().next_attempt_at > t(10));

    assert_eq!(
        outbox.expedite_all(t(10)),
        1,
        "only the newer one was still waiting"
    );
    let due: Vec<String> = outbox
        .items()
        .into_iter()
        .filter(|i| i.state == ItemState::Queued && i.next_attempt_at <= t(10))
        .map(|i| i.client_photo_id)
        .collect();
    assert_eq!(due, vec![old.clone(), new.clone()]);
    assert!(
        needs_attention(&outbox.get(&stuck).unwrap()).contains("409"),
        "needs attention is untouched"
    );
    // The backoff count stays, so a still-failing item keeps backing off.
    assert_eq!(outbox.get(&old).unwrap().attempts, 8);
    assert_eq!(
        outbox.expedite_all(t(10)),
        0,
        "nothing left to bring forward"
    );
    assert!(!outbox.expedite_next(t(10)));
}
