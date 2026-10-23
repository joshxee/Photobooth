//! The portal upload, wired into the app (DESIGN §10 items 3 and 5; session 10):
//!
//! - [`hook`]: a completed session's shots are encoded (08b) and queued, one at a time on
//!   their own thread, so neither step delays the review screen;
//! - [`pump`]: the upload loop drains the queue while the booth is enrolled, on its own thread
//!   (the outbox does blocking file work), pausing on a revoked device;
//! - [`Uploads`]: what both share, and what the operator sees: counts, flags and the
//!   needs-attention list, with retry and dismiss.

pub mod disk;
pub mod hook;
pub mod pump;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use photobooth_core::outbox::{EncodedShot, ItemState, Outbox, OutboxError, OutboxItem};
use tokio::sync::{watch, Notify};

use crate::dto::{CommandError, OutboxEntry, OutboxEntryKind, OutboxStatus};

/// Shots that couldn't be queued are kept in the list (memory only) up to this many.
const MAX_NOTICES: usize = 50;
const NOTICE_PREFIX: &str = "notice-";

/// How the upload loop's last wait ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Woke {
    /// Something was queued, retried or (un)enrolled.
    Nudged,
    /// The requested time passed.
    Timer,
    Shutdown,
}

/// What the loop knows that the outbox doesn't. Changing it re-sends the status.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LoopFacts {
    offline: bool,
    /// The enrolment epoch whose credential the portal refused.
    revoked_epoch: Option<u64>,
    /// Bumped when the not-queued list changes.
    notices: u64,
}

/// A shot that never reached the queue.
#[derive(Clone, Debug)]
struct Notice {
    id: String,
    session_id: String,
    shot: u8,
    reason: String,
}

/// Shared by the completion hook, the upload loop and the operator's commands.
pub struct Uploads {
    outbox: Outbox,
    nudge: Notify,
    shutdown: watch::Sender<bool>,
    facts: watch::Sender<LoopFacts>,
    /// Bumped by every enrolment and unenrolment.
    epoch: AtomicU64,
    notices: Mutex<VecDeque<Notice>>,
    next_notice: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Uploads {
    pub fn new(outbox: Outbox) -> Self {
        Self {
            outbox,
            nudge: Notify::new(),
            shutdown: watch::channel(false).0,
            facts: watch::channel(LoopFacts::default()).0,
            epoch: AtomicU64::new(0),
            notices: Mutex::new(VecDeque::new()),
            next_notice: AtomicU64::new(1),
        }
    }

    pub fn outbox(&self) -> &Outbox {
        &self.outbox
    }

    /// Queues one encoded shot and wakes the upload loop. Blocking file I/O: call it off the
    /// UI path.
    pub fn enqueue(
        &self,
        event_id: &str,
        session_id: &str,
        shot: u8,
        captured_at: SystemTime,
        encoded: EncodedShot,
    ) -> Result<OutboxItem, OutboxError> {
        let item = self
            .outbox
            .enqueue(event_id, session_id, shot, captured_at, encoded)?;
        self.nudge();
        Ok(item)
    }

    /// Remembers a shot that couldn't be queued, for the operator's list (memory only: the
    /// original is on the camera's SD card, and nothing here could upload it again).
    pub fn not_queued(&self, session_id: &str, shot: u8, reason: impl Into<String>) {
        let n = self.next_notice.fetch_add(1, Ordering::Relaxed);
        let mut notices = lock(&self.notices);
        if notices.len() == MAX_NOTICES {
            notices.pop_front();
        }
        notices.push_back(Notice {
            id: format!("{NOTICE_PREFIX}{n}"),
            session_id: session_id.to_owned(),
            shot,
            reason: reason.into(),
        });
        drop(notices);
        self.facts.send_modify(|f| f.notices += 1);
    }

    // ----- what the operator sees -------------------------------------------------------

    pub fn status(&self) -> OutboxStatus {
        let stats = self.outbox.stats();
        let facts = *self.facts.borrow();
        OutboxStatus {
            available: true,
            queued: stats.queued,
            uploading: stats.uploading,
            needs_attention: stats.needs_attention + lock(&self.notices).len(),
            offline: facts.offline,
            revoked: facts.revoked_epoch == Some(self.epoch()),
            free_bytes: stats.free_bytes,
            low_disk: stats.low_disk,
        }
    }

    /// Resolves whenever [`Uploads::status`] may have changed; `false` once nothing can
    /// change any more.
    pub fn status_feed(&self) -> StatusFeed {
        StatusFeed {
            outbox: self.outbox.subscribe(),
            facts: self.facts.subscribe(),
        }
    }

    /// The needs-attention list: stopped uploads (oldest capture first), files without a
    /// record, then shots that couldn't be queued.
    pub fn entries(&self) -> Vec<OutboxEntry> {
        let uploads = self.outbox.items().into_iter().filter_map(|item| {
            let ItemState::NeedsAttention { reason } = &item.state else {
                return None;
            };
            Some(OutboxEntry {
                id: item.client_photo_id.clone(),
                kind: OutboxEntryKind::Upload,
                reason: reason.clone(),
                session_id: Some(item.session_id.clone()),
                shot: Some(item.shot),
                captured_at: Some(item.captured_at_iso()),
                event_id: Some(item.event_id.clone()),
                can_retry: true,
            })
        });
        let damaged = self.outbox.quarantined().into_iter().map(|q| OutboxEntry {
            id: q.id,
            kind: OutboxEntryKind::Damaged,
            reason: q.reason,
            session_id: None,
            shot: None,
            captured_at: None,
            event_id: None,
            can_retry: false,
        });
        let notices: Vec<OutboxEntry> = lock(&self.notices)
            .iter()
            .map(|n| OutboxEntry {
                id: n.id.clone(),
                kind: OutboxEntryKind::NotQueued,
                reason: n.reason.clone(),
                session_id: Some(n.session_id.clone()),
                shot: Some(n.shot),
                captured_at: None,
                event_id: None,
                can_retry: false,
            })
            .collect();
        uploads.chain(damaged).chain(notices).collect()
    }

    /// The operator's retry of a stopped upload: queued again, due at once.
    pub fn retry(&self, id: &str) -> Result<(), CommandError> {
        if id.starts_with(NOTICE_PREFIX) {
            return Err(CommandError::new(
                "That shot was never queued, so there is nothing to retry. The camera's SD card \
                 has the original.",
            ));
        }
        self.outbox.retry(id).map_err(explain)?;
        self.nudge();
        Ok(())
    }

    /// The operator's dismiss (confirmed in the UI): deletes the booth's copy of a stopped
    /// upload or a damaged set, or acknowledges a shot that wasn't queued.
    pub fn dismiss(&self, id: &str) -> Result<(), CommandError> {
        if id.starts_with(NOTICE_PREFIX) {
            let mut notices = lock(&self.notices);
            let before = notices.len();
            notices.retain(|n| n.id != id);
            if notices.len() == before {
                return Err(CommandError::new("That entry is no longer in the list."));
            }
            drop(notices);
            self.facts.send_modify(|f| f.notices += 1);
            return Ok(());
        }
        self.outbox.dismiss(id).map_err(explain)
    }

    // ----- the upload loop's controls ---------------------------------------------------

    /// Bumped by every enrolment and unenrolment: a refused credential only pauses the
    /// epoch it belonged to.
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The booth was enrolled or unenrolled: lift a revoked pause and wake the loop.
    pub fn enrolment_changed(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        // Re-sends the status: `revoked` depends on the epoch.
        self.facts.send_modify(|_| {});
        self.nudge();
    }

    pub fn revoked_epoch(&self) -> Option<u64> {
        self.facts.borrow().revoked_epoch
    }

    pub(crate) fn set_revoked(&self, epoch: u64) {
        self.facts.send_if_modified(|f| {
            let changed = f.revoked_epoch != Some(epoch) || f.offline;
            f.revoked_epoch = Some(epoch);
            f.offline = false;
            changed
        });
    }

    pub(crate) fn set_offline(&self, offline: bool) {
        self.facts.send_if_modified(|f| {
            let changed = f.offline != offline;
            f.offline = offline;
            changed
        });
    }

    /// Wakes the upload loop now (or as soon as it next waits).
    pub fn nudge(&self) {
        self.nudge.notify_one();
    }

    /// Stops the upload loop. An upload in flight is abandoned; its item is still queued on
    /// disk and goes at the next start.
    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub fn is_shut_down(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// Resolves once [`Uploads::shutdown`] has been called.
    pub async fn stopped(&self) {
        let mut rx = self.shutdown.subscribe();
        let _ = rx.wait_for(|stopped| *stopped).await;
    }

    /// Waits for a nudge, `timeout` (forever if `None`) or shutdown, whichever comes first.
    pub async fn wait(&self, timeout: Option<Duration>) -> Woke {
        if self.is_shut_down() {
            return Woke::Shutdown;
        }
        let timer = async {
            match timeout {
                Some(after) => tokio::time::sleep(after).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = self.nudge.notified() => Woke::Nudged,
            () = timer => Woke::Timer,
            () = self.stopped() => Woke::Shutdown,
        }
    }
}

/// See [`Uploads::status_feed`].
pub struct StatusFeed {
    outbox: watch::Receiver<u64>,
    facts: watch::Receiver<LoopFacts>,
}

impl StatusFeed {
    pub async fn changed(&mut self) -> bool {
        tokio::select! {
            r = self.outbox.changed() => r.is_ok(),
            r = self.facts.changed() => r.is_ok(),
        }
    }
}

/// The operator's version of an outbox refusal.
fn explain(err: OutboxError) -> CommandError {
    CommandError::new(match err {
        OutboxError::UnknownItem(_) => "That photo is no longer in the queue.".to_owned(),
        OutboxError::Quarantined(_) => {
            "These files have no record, so they can't be uploaded. Dismiss them instead."
                .to_owned()
        }
        OutboxError::WrongState(_) => {
            "That photo is queued or uploading right now; try again once it has stopped.".to_owned()
        }
        other => format!("Couldn't update the upload queue: {other}"),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Arc;

    use photobooth_core::outbox::{FixedJitter, OutboxOptions, UnknownDiskSpace};

    pub const EVENT: &str = "019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01";

    pub fn open_outbox(dir: &std::path::Path) -> Outbox {
        Outbox::open_with(
            dir,
            OutboxOptions {
                jitter: Arc::new(FixedJitter(1.0)),
                disk: Arc::new(UnknownDiskSpace),
            },
        )
        .unwrap()
    }

    pub fn encoded(seed: u8) -> EncodedShot {
        EncodedShot {
            thumb: vec![0xFF, 0xD8, seed, 1, 0xFF, 0xD9],
            hd: vec![0xFF, 0xD8, seed, 2, 2, 0xFF, 0xD9],
            width: 2560,
            height: 1707,
        }
    }

    fn uploads(dir: &tempfile::TempDir) -> Uploads {
        Uploads::new(open_outbox(dir.path()))
    }

    fn queue(u: &Uploads, shot: u8) -> String {
        u.enqueue(EVENT, "6a3f1c20-3", shot, SystemTime::now(), encoded(shot))
            .unwrap()
            .client_photo_id
    }

    #[test]
    fn status_counts_every_kind_of_needs_attention() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        let a = queue(&u, 1);
        queue(&u, 2);
        u.outbox()
            .mark_needs_attention(&a, "event_closed (409)")
            .unwrap();
        u.not_queued("6a3f1c20-4", 2, "decode failed");
        assert_eq!(
            u.status(),
            OutboxStatus {
                available: true,
                queued: 1,
                uploading: 0,
                needs_attention: 2,
                offline: false,
                revoked: false,
                free_bytes: None,
                low_disk: false,
            }
        );
    }

    #[test]
    fn the_list_has_reasons_and_ids_and_never_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        let stopped = queue(&u, 3);
        queue(&u, 1); // still queued: not in the list
        u.outbox()
            .mark_needs_attention(&stopped, "event_closed (409)")
            .unwrap();
        u.not_queued("6a3f1c20-4", 2, "decode failed");

        let entries = u.entries();
        assert_eq!(entries.len(), 2);
        let upload = &entries[0];
        assert_eq!(upload.id, stopped);
        assert_eq!(upload.kind, OutboxEntryKind::Upload);
        assert_eq!(upload.reason, "event_closed (409)");
        assert_eq!(upload.session_id.as_deref(), Some("6a3f1c20-3"));
        assert_eq!(upload.shot, Some(3));
        assert_eq!(upload.event_id.as_deref(), Some(EVENT));
        assert!(upload.can_retry);
        let notice = &entries[1];
        assert_eq!(notice.kind, OutboxEntryKind::NotQueued);
        assert_eq!(
            (notice.session_id.as_deref(), notice.shot),
            (Some("6a3f1c20-4"), Some(2))
        );
        assert!(!notice.can_retry);

        // Only small fields cross IPC.
        let json = serde_json::to_string(&entries).unwrap();
        assert!(json.len() < 1000, "{json}");
        assert!(
            !json.contains("sha256") && !json.contains("thumb"),
            "{json}"
        );
    }

    #[test]
    fn retry_requeues_and_dismiss_deletes_the_booth_copy() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        let id = queue(&u, 1);
        u.outbox()
            .mark_needs_attention(&id, "conflict (409)")
            .unwrap();

        u.retry(&id).unwrap();
        assert_eq!(u.status().queued, 1);
        let err = u.retry(&id).unwrap_err();
        assert!(err.0.contains("queued or uploading"), "{err}");

        u.outbox()
            .mark_needs_attention(&id, "conflict (409)")
            .unwrap();
        u.dismiss(&id).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        assert_eq!(u.status().needs_attention, 0);
        let err = u.dismiss(&id).unwrap_err();
        assert!(err.0.contains("no longer in the queue"), "{err}");
    }

    #[test]
    fn a_shot_that_was_never_queued_can_only_be_dismissed() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        u.not_queued("6a3f1c20-4", 2, "decode failed");
        let id = u.entries()[0].id.clone();
        assert!(u.retry(&id).unwrap_err().0.contains("never queued"));
        u.dismiss(&id).unwrap();
        assert!(u.entries().is_empty());
        assert!(u.dismiss(&id).is_err());
    }

    #[test]
    fn the_not_queued_list_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        for n in 0..(MAX_NOTICES + 5) {
            u.not_queued("s-1", (n % 3) as u8 + 1, format!("failure {n}"));
        }
        let entries = u.entries();
        assert_eq!(entries.len(), MAX_NOTICES);
        assert_eq!(entries[0].reason, "failure 5", "the oldest go first");
    }

    #[test]
    fn a_revoked_pause_lasts_until_the_enrolment_changes() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        u.set_offline(true);
        u.set_revoked(u.epoch());
        let status = u.status();
        assert!(status.revoked);
        assert!(!status.offline, "refused is not offline");
        u.enrolment_changed();
        assert!(!u.status().revoked);
    }

    #[tokio::test]
    async fn the_status_feed_fires_on_queue_and_loop_changes() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        let mut feed = u.status_feed();
        let fires = |feed: &mut StatusFeed| {
            let mut fut = Box::pin(feed.changed());
            matches!(futures_util::FutureExt::now_or_never(&mut fut), Some(true))
        };
        assert!(!fires(&mut feed));
        queue(&u, 1);
        assert!(fires(&mut feed), "enqueue");
        u.set_offline(true);
        assert!(fires(&mut feed), "offline");
        u.set_offline(true);
        assert!(!fires(&mut feed), "no change, no event");
        u.not_queued("s-1", 1, "x");
        assert!(fires(&mut feed), "not queued");
        u.enrolment_changed();
        assert!(fires(&mut feed), "enrolment");
    }

    #[tokio::test(start_paused = true)]
    async fn wait_ends_on_a_nudge_a_timer_or_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let u = uploads(&dir);
        u.nudge();
        assert_eq!(
            u.wait(None).await,
            Woke::Nudged,
            "a nudge before the wait counts"
        );
        assert_eq!(u.wait(Some(Duration::from_secs(30))).await, Woke::Timer);
        u.shutdown();
        assert_eq!(u.wait(None).await, Woke::Shutdown);
    }
}
