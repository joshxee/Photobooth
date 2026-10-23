//! One pass over the due items: intent, then PUT each variant the server still needs, then
//! delete on READY, applying DESIGN §9.3 to every answer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use super::client::{Action, IntentOutcome, PortalClient, PortalError, UploadOutcome};
use super::{ItemState, Outbox, OutboxError, OutboxItem};

/// Items uploading at once (DESIGN §10).
pub const MAX_CONCURRENT_UPLOADS: usize = 2;

/// Intents per item per pass. Re-posting the intent is how an expired upload URL is renewed
/// and how "every variant stored but not READY yet" is resolved; past this the item backs off.
pub const MAX_INTENTS_PER_ATTEMPT: usize = 3;

/// What a pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrainReport {
    pub ready: usize,
    pub retried: usize,
    pub needs_attention: usize,
    /// Of `retried`, the attempts that got no HTTP answer at all (the booth is offline, or
    /// behind a captive portal).
    pub network_failures: usize,
    /// The portal refused the device's credential (401). The pass stopped at once and the
    /// items it had claimed are queued again, untouched.
    pub revoked: bool,
}

/// How one item's attempt ended.
#[derive(Debug)]
enum Step {
    Ready,
    Retry {
        error: String,
        retry_after: Option<Duration>,
        network: bool,
    },
    HashMismatch(String),
    NeedsAttention(String),
    Revoked,
}

impl Step {
    fn retry(error: String, retry_after: Option<Duration>) -> Step {
        Step::Retry {
            error,
            retry_after,
            network: false,
        }
    }

    fn from_error(error: &PortalError) -> Option<Step> {
        let message = error.to_string();
        match error.action() {
            Action::Retry { retry_after } => Some(Step::Retry {
                error: message,
                retry_after,
                network: matches!(error, PortalError::Network(_)),
            }),
            Action::HashMismatch => Some(Step::HashMismatch(message)),
            Action::NeedsAttention => Some(Step::NeedsAttention(message)),
            Action::Revoked => Some(Step::Revoked),
            // The caller re-posts the intent.
            Action::ReIntent => None,
        }
    }
}

impl Outbox {
    /// Uploads every item due at `now`, at most [`MAX_CONCURRENT_UPLOADS`] at a time, oldest
    /// capture first. Items that fail get their next attempt time from `now`, so one pass
    /// never tries an item twice. The upload loop calls this, then sleeps until
    /// [`Outbox::next_attempt_at`] or the next enqueue. A refused credential ends the pass
    /// early ([`DrainReport::revoked`]).
    ///
    /// The two-upload limit is per call: run one drain at a time (a single upload loop).
    /// File work (reading a variant, up to the contract's 3 MB HD cap; the record write and
    /// `fsync`s in each `mark_*`) is blocking and runs inline, so drive this from a thread
    /// that may block, not the UI's async workers.
    pub async fn drain_once(&self, client: &dyn PortalClient, now: SystemTime) -> DrainReport {
        let revoked = AtomicBool::new(false);
        let worker = || async {
            let mut report = DrainReport::default();
            while !revoked.load(Ordering::SeqCst) {
                let Some(item) = self.claim_due(now) else {
                    break;
                };
                let step = self.attempt(client, &item).await;
                if matches!(step, Step::Revoked) {
                    revoked.store(true, Ordering::SeqCst);
                }
                self.apply(&item, step, now, &mut report);
            }
            report
        };
        let reports: [DrainReport; MAX_CONCURRENT_UPLOADS] = {
            let (a, b) = tokio::join!(worker(), worker());
            [a, b]
        };
        let mut total = reports
            .into_iter()
            .fold(DrainReport::default(), |total, r| DrainReport {
                ready: total.ready + r.ready,
                retried: total.retried + r.retried,
                needs_attention: total.needs_attention + r.needs_attention,
                network_failures: total.network_failures + r.network_failures,
                revoked: false,
            });
        total.revoked = revoked.into_inner();
        total
    }

    async fn attempt(&self, client: &dyn PortalClient, item: &OutboxItem) -> Step {
        let id = &item.client_photo_id;
        'intent: for _ in 0..MAX_INTENTS_PER_ATTEMPT {
            let uploads = match client.intent(item).await {
                Ok(IntentOutcome::Ready) => return Step::Ready,
                Ok(IntentOutcome::Rejected { reason }) => {
                    return Step::NeedsAttention(format!("rejected by the server: {reason}"));
                }
                Ok(IntentOutcome::Pending { uploads }) => uploads,
                Err(error) => match Step::from_error(&error) {
                    Some(step) => return step,
                    None => continue 'intent,
                },
            };
            if uploads.is_empty() {
                return Step::retry(
                    "server is still waiting for the photo (no uploads requested)".to_owned(),
                    None,
                );
            }
            for upload in &uploads {
                let body = match self.read_variant(id, upload.variant) {
                    Ok(body) => body,
                    Err(OutboxError::Corrupt(reason)) => return Step::NeedsAttention(reason),
                    // Anything else (a transient I/O error) is worth another try.
                    Err(err) => return Step::retry(err.to_string(), None),
                };
                match client.upload(upload, body).await {
                    Ok(UploadOutcome::Ready) => return Step::Ready,
                    Ok(UploadOutcome::Stored) => {}
                    Ok(UploadOutcome::Processing { retry_after }) => {
                        return Step::retry(
                            "server is processing the upload (202)".to_owned(),
                            retry_after,
                        );
                    }
                    Err(error) => match Step::from_error(&error) {
                        Some(step) => return step,
                        None => continue 'intent,
                    },
                }
            }
            tracing::debug!(id = %id, "every requested variant stored; asking again");
        }
        Step::retry(
            format!("not READY after {MAX_INTENTS_PER_ATTEMPT} intents"),
            None,
        )
    }

    fn apply(&self, item: &OutboxItem, step: Step, now: SystemTime, report: &mut DrainReport) {
        let id = &item.client_photo_id;
        let result = match step {
            Step::Ready => self.mark_ready(id).map(|()| report.ready += 1),
            Step::Retry {
                error,
                retry_after,
                network,
            } => self.mark_retry(id, &error, retry_after, now).map(|_| {
                report.retried += 1;
                if network {
                    report.network_failures += 1;
                }
            }),
            Step::HashMismatch(error) => self.mark_hash_mismatch(id, &error, now).map(|retrying| {
                if retrying {
                    report.retried += 1;
                } else {
                    report.needs_attention += 1;
                }
            }),
            Step::NeedsAttention(reason) => self
                .mark_needs_attention(id, &reason)
                .map(|()| report.needs_attention += 1),
            Step::Revoked => {
                self.unclaim(id);
                Ok(())
            }
        };
        if let Err(err) = result {
            // The record or the files could not be updated (disk full, I/O error). The new
            // state is already in memory, except after a failed READY delete, which leaves
            // the item claimed: requeue it. The server is idempotent, so trying again is safe.
            tracing::error!(id = %id, %err, "outbox update failed");
            let claimed = self
                .get(id)
                .is_some_and(|i| i.state == ItemState::Uploading);
            if claimed {
                if let Err(err) = self.mark_retry(id, &err.to_string(), None, now) {
                    tracing::error!(id = %id, %err, "outbox item could not be requeued");
                }
                report.retried += 1;
            }
        }
    }
}
