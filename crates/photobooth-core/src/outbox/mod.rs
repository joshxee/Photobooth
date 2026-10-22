//! The portal upload outbox: a durable, crash-safe queue of completed shots, each held as its
//! two booth-made variants (DESIGN D1, D14) until the server confirms READY.
//!
//! One directory, three files per shot, all written temp → `fsync` → rename:
//!
//! ```text
//! {client_photo_id}.thumb.jpg   written first
//! {client_photo_id}.hd.jpg
//! {client_photo_id}.json        written last: the commit point of an enqueue
//! ```
//!
//! [`Outbox::open`] turns whatever a crash left into a known state: `*.tmp` files are
//! incomplete writes and are deleted; a record missing a variant needs attention; variants
//! without a readable record are quarantined (needs attention). Nothing else is ever deleted
//! except by READY ([`Outbox::mark_ready`]) or the operator ([`Outbox::dismiss`]).
//!
//! The upload itself is behind [`PortalClient`]; [`Outbox::drain_once`] applies DESIGN §9.3.
//! There is no HTTP, Tauri or image code here.

mod backoff;
mod client;
mod drain;
mod item;
mod time;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub use backoff::{
    backoff_delay, retry_delay, FixedJitter, Jitter, RandomJitter, BACKOFF_BASE, BACKOFF_CAP,
    MAX_RETRY_AFTER,
};
pub use client::{
    ErrorCode, IntentOutcome, PortalClient, PortalError, UploadDescriptor, UploadOutcome,
};
pub use drain::{DrainReport, MAX_CONCURRENT_UPLOADS, MAX_INTENTS_PER_ATTEMPT};
pub use item::{EncodedShot, ItemState, OutboxItem, Quarantined, Variant, VariantInfo};
pub use time::iso_millis;

use item::{is_contract_id, is_contract_session_id, record_file_name};

/// Below this much free space the operator is warned (DESIGN §10). Nothing is evicted.
pub const LOW_DISK_BYTES: u64 = 1_000_000_000;

/// `hash_mismatch` answers retried before the item needs attention (DESIGN §9.3).
pub const MAX_HASH_MISMATCH_RETRIES: u32 = 3;

/// The record format; bumped if the JSON shape changes incompatibly.
const RECORD_FORMAT: u32 = 1;

const TMP_SUFFIX: &str = ".tmp";

/// Free space on the volume holding the outbox. A trait so tests can fake a full disk; the
/// app supplies the platform's implementation.
pub trait DiskSpace: Send + Sync {
    fn free_bytes(&self, dir: &Path) -> io::Result<u64>;
}

/// For platforms without a [`DiskSpace`] yet: free space is unknown, never "low".
#[derive(Clone, Copy, Debug, Default)]
pub struct UnknownDiskSpace;

impl DiskSpace for UnknownDiskSpace {
    fn free_bytes(&self, _dir: &Path) -> io::Result<u64> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "free space is not available on this platform",
        ))
    }
}

/// What [`Outbox::open_with`] can be given instead of the defaults.
#[derive(Clone)]
pub struct OutboxOptions {
    pub jitter: Arc<dyn Jitter>,
    pub disk: Arc<dyn DiskSpace>,
}

impl Default for OutboxOptions {
    fn default() -> Self {
        Self {
            jitter: Arc::new(RandomJitter::new()),
            disk: Arc::new(UnknownDiskSpace),
        }
    }
}

/// Counts for the operator status bar (DESIGN §10 item 5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutboxStats {
    pub queued: usize,
    pub uploading: usize,
    /// Items stopped for the operator, plus quarantined files.
    pub needs_attention: usize,
    /// `None` when the platform can't say.
    pub free_bytes: Option<u64>,
    /// Free space is known and below [`LOW_DISK_BYTES`].
    pub low_disk: bool,
}

#[derive(Debug, Error)]
pub enum OutboxError {
    #[error("outbox I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("outbox record could not be encoded: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("invalid shot: {0}")]
    Invalid(String),
    #[error("no outbox item {0}")]
    UnknownItem(String),
    #[error("{0}")]
    Corrupt(String),
    #[error("{0} has no record and can only be dismissed")]
    Quarantined(String),
    #[error("{0}")]
    WrongState(String),
}

/// On-disk record: the item plus a format number.
#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    format: u32,
    item: OutboxItem,
}

#[derive(Default)]
struct Entries {
    items: BTreeMap<String, OutboxItem>,
    quarantined: BTreeMap<String, Quarantined>,
}

struct Inner {
    dir: PathBuf,
    entries: Mutex<Entries>,
    jitter: Arc<dyn Jitter>,
    disk: Arc<dyn DiskSpace>,
}

/// The outbox. Cheap to clone; clones share state. File I/O is blocking and small (a few
/// hundred KB per shot), so call [`Outbox::enqueue`] off the UI path.
#[derive(Clone)]
pub struct Outbox {
    inner: Arc<Inner>,
}

impl Outbox {
    /// Opens (creating if needed) the outbox in `dir`, with OS-seeded jitter and unknown
    /// free space.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, OutboxError> {
        Self::open_with(dir, OutboxOptions::default())
    }

    pub fn open_with(dir: impl Into<PathBuf>, options: OutboxOptions) -> Result<Self, OutboxError> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let entries = scan(&dir)?;
        tracing::info!(
            dir = %dir.display(),
            items = entries.items.len(),
            quarantined = entries.quarantined.len(),
            "outbox opened"
        );
        Ok(Self {
            inner: Arc::new(Inner {
                dir,
                entries: Mutex::new(entries),
                jitter: options.jitter,
                disk: options.disk,
            }),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    // Every operation is a few map calls plus small file writes; none panics midway with the
    // map half-updated, so recovering from poisoning is sound. Never held across an await.
    fn entries(&self) -> MutexGuard<'_, Entries> {
        self.inner.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queues one shot: hashes both variants, writes them, then the record (last), each
    /// durably. Returns the new item, due at once.
    pub fn enqueue(
        &self,
        event_id: &str,
        session_id: &str,
        shot: u8,
        captured_at: SystemTime,
        encoded: EncodedShot,
    ) -> Result<OutboxItem, OutboxError> {
        if !is_contract_id(event_id) {
            return Err(OutboxError::Invalid(format!(
                "event id {event_id:?} is not a lowercase UUID"
            )));
        }
        if !is_contract_session_id(session_id) {
            return Err(OutboxError::Invalid(format!(
                "session id {session_id:?} does not match the contract"
            )));
        }
        if encoded.thumb.is_empty() || encoded.hd.is_empty() {
            return Err(OutboxError::Invalid("a variant is empty".to_owned()));
        }
        if encoded.width == 0 || encoded.height == 0 {
            return Err(OutboxError::Invalid("the HD size is zero".to_owned()));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let item = OutboxItem {
            client_photo_id: id.clone(),
            event_id: event_id.to_owned(),
            session_id: session_id.to_owned(),
            shot,
            captured_at: time::truncate_to_millis(captured_at),
            width: encoded.width,
            height: encoded.height,
            thumb: variant_info(&encoded.thumb),
            hd: variant_info(&encoded.hd),
            state: ItemState::Queued,
            attempts: 0,
            hash_mismatches: 0,
            next_attempt_at: UNIX_EPOCH,
            last_error: None,
        };

        let dir = self.dir();
        let written = (|| -> Result<(), OutboxError> {
            write_durably(dir, &Variant::Thumb.file_name(&id), &encoded.thumb)?;
            write_durably(dir, &Variant::Hd.file_name(&id), &encoded.hd)?;
            // The variant renames must be durable before the record can name them.
            sync_dir(dir)?;
            write_durably(dir, &record_file_name(&id), &encode_record(&item)?)?;
            sync_dir(dir)?;
            Ok(())
        })();
        if let Err(err) = written {
            // Never queued, so nothing of it may stay behind for open() to quarantine.
            for name in item_files(&id) {
                remove_if_present(&dir.join(&name));
                remove_if_present(&dir.join(format!("{name}{TMP_SUFFIX}")));
            }
            return Err(err);
        }

        tracing::info!(
            id = %id,
            event_id,
            session_id,
            shot,
            thumb_bytes = item.thumb.bytes,
            hd_bytes = item.hd.bytes,
            "shot queued"
        );
        self.entries().items.insert(id, item.clone());
        Ok(item)
    }

    /// Every item, oldest capture first.
    pub fn items(&self) -> Vec<OutboxItem> {
        let mut items: Vec<OutboxItem> = self.entries().items.values().cloned().collect();
        items.sort_by(|a, b| {
            (a.captured_at, &a.client_photo_id).cmp(&(b.captured_at, &b.client_photo_id))
        });
        items
    }

    pub fn get(&self, id: &str) -> Option<OutboxItem> {
        self.entries().items.get(id).cloned()
    }

    /// Files found on open without a usable record.
    pub fn quarantined(&self) -> Vec<Quarantined> {
        self.entries().quarantined.values().cloned().collect()
    }

    /// The queued item that is due at `now` and has waited longest (oldest capture first).
    pub fn next_due(&self, now: SystemTime) -> Option<OutboxItem> {
        next_due_in(&self.entries(), now).cloned()
    }

    /// When the earliest queued item becomes due, for the upload loop to sleep until.
    pub fn next_attempt_at(&self) -> Option<SystemTime> {
        self.entries()
            .items
            .values()
            .filter(|i| i.state == ItemState::Queued)
            .map(|i| i.next_attempt_at)
            .min()
    }

    /// Takes the next due item for upload (`Uploading`, in memory only).
    pub(crate) fn claim_due(&self, now: SystemTime) -> Option<OutboxItem> {
        let mut entries = self.entries();
        let id = next_due_in(&entries, now)?.client_photo_id.clone();
        let item = entries.items.get_mut(&id)?;
        item.state = ItemState::Uploading;
        Some(item.clone())
    }

    /// The server confirmed READY: deletes the variants, then the record. A crash between
    /// the two leaves a record missing a variant, which needs attention on the next open; a
    /// retry then re-posts the intent, which answers READY again and finishes the delete.
    pub fn mark_ready(&self, id: &str) -> Result<(), OutboxError> {
        let mut entries = self.entries();
        if !entries.items.contains_key(id) {
            return Err(OutboxError::UnknownItem(id.to_owned()));
        }
        delete_files(self.dir(), id)?;
        entries.items.remove(id);
        tracing::info!(id, "upload confirmed READY; local variants deleted");
        Ok(())
    }

    /// A transient failure: back to the queue after the jittered backoff for the new attempt
    /// count, or `retry_after` if that is longer. Returns when the item is next due.
    pub fn mark_retry(
        &self,
        id: &str,
        error: &str,
        retry_after: Option<Duration>,
        now: SystemTime,
    ) -> Result<SystemTime, OutboxError> {
        let jitter = self.inner.jitter.fraction();
        let mut entries = self.entries();
        let item = entries
            .items
            .get_mut(id)
            .ok_or_else(|| OutboxError::UnknownItem(id.to_owned()))?;
        item.attempts = item.attempts.saturating_add(1);
        let delay = retry_delay(item.attempts, jitter, retry_after);
        item.state = ItemState::Queued;
        item.next_attempt_at = time::truncate_to_millis(now + delay);
        item.last_error = Some(error.to_owned());
        tracing::info!(
            id,
            attempts = item.attempts,
            delay_ms = delay.as_millis() as u64,
            error,
            "upload will be retried"
        );
        let next = item.next_attempt_at;
        persist(self.dir(), item)?;
        Ok(next)
    }

    /// A `hash_mismatch` answer: retried up to [`MAX_HASH_MISMATCH_RETRIES`] times, then the
    /// item needs attention.
    pub(crate) fn mark_hash_mismatch(
        &self,
        id: &str,
        error: &str,
        now: SystemTime,
    ) -> Result<bool, OutboxError> {
        let mismatches = {
            let mut entries = self.entries();
            let item = entries
                .items
                .get_mut(id)
                .ok_or_else(|| OutboxError::UnknownItem(id.to_owned()))?;
            item.hash_mismatches = item.hash_mismatches.saturating_add(1);
            item.hash_mismatches
        };
        if mismatches > MAX_HASH_MISMATCH_RETRIES {
            self.mark_needs_attention(id, error)?;
            Ok(false)
        } else {
            self.mark_retry(id, error, None, now)?;
            Ok(true)
        }
    }

    /// Stops the item until the operator retries or dismisses it. Its files are kept.
    pub fn mark_needs_attention(&self, id: &str, reason: &str) -> Result<(), OutboxError> {
        let mut entries = self.entries();
        let item = entries
            .items
            .get_mut(id)
            .ok_or_else(|| OutboxError::UnknownItem(id.to_owned()))?;
        item.state = ItemState::NeedsAttention {
            reason: reason.to_owned(),
        };
        item.last_error = Some(reason.to_owned());
        tracing::warn!(id, reason, "upload needs attention");
        persist(self.dir(), item)
    }

    /// The operator's retry of an item that needs attention: back to the queue, due at once,
    /// with the backoff and the hash-mismatch count reset. A queued or uploading item is
    /// refused, so a stale or repeated tap can neither reset a backoff nor start a second
    /// upload of an item already in flight.
    pub fn retry(&self, id: &str) -> Result<(), OutboxError> {
        let mut entries = self.entries();
        if entries.quarantined.contains_key(id) {
            return Err(OutboxError::Quarantined(id.to_owned()));
        }
        let item = entries
            .items
            .get_mut(id)
            .ok_or_else(|| OutboxError::UnknownItem(id.to_owned()))?;
        if !matches!(item.state, ItemState::NeedsAttention { .. }) {
            return Err(OutboxError::WrongState(format!(
                "{id} does not need attention; only those items can be retried"
            )));
        }
        item.state = ItemState::Queued;
        item.attempts = 0;
        item.hash_mismatches = 0;
        item.next_attempt_at = UNIX_EPOCH;
        persist(self.dir(), item)
    }

    /// The operator's dismiss (after confirming in the UI; the SD card still has the
    /// original): deletes the local files of an item or a quarantined set. Refused while
    /// the item is uploading, so its files can't vanish mid-PUT.
    pub fn dismiss(&self, id: &str) -> Result<(), OutboxError> {
        let mut entries = self.entries();
        if entries
            .items
            .get(id)
            .is_some_and(|i| i.state == ItemState::Uploading)
        {
            return Err(OutboxError::WrongState(format!(
                "{id} is uploading; dismiss it after the attempt ends"
            )));
        }
        if let Some(quarantined) = entries.quarantined.get(id) {
            for name in &quarantined.files {
                remove_existing(&self.dir().join(name))?;
            }
            sync_dir(self.dir())?;
            entries.quarantined.remove(id);
        } else if entries.items.contains_key(id) {
            delete_files(self.dir(), id)?;
            entries.items.remove(id);
        } else {
            return Err(OutboxError::UnknownItem(id.to_owned()));
        }
        tracing::info!(id, "outbox entry dismissed by the operator");
        Ok(())
    }

    /// Reads a variant for upload, checking it against the hash in its record so a damaged
    /// file is caught here rather than as a `hash_mismatch` from the server.
    pub fn read_variant(&self, id: &str, variant: Variant) -> Result<Bytes, OutboxError> {
        let expected = self
            .get(id)
            .ok_or_else(|| OutboxError::UnknownItem(id.to_owned()))?
            .variant(variant)
            .clone();
        let path = self.dir().join(variant.file_name(id));
        let bytes = fs::read(&path).map_err(|err| match err.kind() {
            io::ErrorKind::NotFound => {
                OutboxError::Corrupt(format!("{variant} variant file missing"))
            }
            _ => OutboxError::Io(err),
        })?;
        if bytes.len() as u64 != expected.bytes || hex_sha256(&bytes) != expected.sha256 {
            return Err(OutboxError::Corrupt(format!(
                "{variant} variant file does not match its record"
            )));
        }
        Ok(Bytes::from(bytes))
    }

    pub fn stats(&self) -> OutboxStats {
        let mut stats = OutboxStats::default();
        {
            let entries = self.entries();
            for item in entries.items.values() {
                match item.state {
                    ItemState::Queued => stats.queued += 1,
                    ItemState::Uploading => stats.uploading += 1,
                    ItemState::NeedsAttention { .. } => stats.needs_attention += 1,
                }
            }
            stats.needs_attention += entries.quarantined.len();
        }
        stats.free_bytes = self.inner.disk.free_bytes(self.dir()).ok();
        stats.low_disk = stats.free_bytes.is_some_and(|free| free < LOW_DISK_BYTES);
        stats
    }
}

fn next_due_in(entries: &Entries, now: SystemTime) -> Option<&OutboxItem> {
    entries
        .items
        .values()
        .filter(|i| i.state == ItemState::Queued && i.next_attempt_at <= now)
        .min_by(|a, b| {
            (a.captured_at, &a.client_photo_id).cmp(&(b.captured_at, &b.client_photo_id))
        })
}

fn variant_info(bytes: &[u8]) -> VariantInfo {
    VariantInfo {
        bytes: bytes.len() as u64,
        sha256: hex_sha256(bytes),
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

fn item_files(id: &str) -> [String; 3] {
    [
        Variant::Thumb.file_name(id),
        Variant::Hd.file_name(id),
        record_file_name(id),
    ]
}

fn encode_record(item: &OutboxItem) -> Result<Vec<u8>, OutboxError> {
    let record = Record {
        format: RECORD_FORMAT,
        item: OutboxItem {
            // Uploading is a claim held in memory, never a state on disk.
            state: match &item.state {
                ItemState::Uploading => ItemState::Queued,
                other => other.clone(),
            },
            ..item.clone()
        },
    };
    Ok(serde_json::to_vec(&record)?)
}

fn persist(dir: &Path, item: &OutboxItem) -> Result<(), OutboxError> {
    write_durably(dir, &item.record_file_name(), &encode_record(item)?)?;
    sync_dir(dir)?;
    Ok(())
}

/// Variants first, record last (see [`Outbox::mark_ready`]).
fn delete_files(dir: &Path, id: &str) -> Result<(), OutboxError> {
    for name in item_files(id) {
        remove_existing(&dir.join(name))?;
    }
    sync_dir(dir)?;
    Ok(())
}

/// Writes `name` via `name.tmp` → `fsync` → rename, so `name` is either the old content or
/// all of the new. Callers `fsync` the directory to make the rename itself durable.
fn write_durably(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let tmp = dir.join(format!("{name}{TMP_SUFFIX}"));
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, dir.join(name))
    })();
    if result.is_err() {
        remove_if_present(&tmp);
    }
    result
}

/// Makes renames and deletes in `dir` durable. Only Unix can open a directory for `fsync`;
/// on Windows (tests on the dev PC) metadata is journaled by NTFS and this is a no-op.
fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

fn remove_existing(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// Best-effort cleanup on a path that already failed.
fn remove_if_present(path: &Path) {
    if let Err(err) = remove_existing(path) {
        tracing::warn!(path = %path.display(), %err, "could not remove a partial outbox file");
    }
}

/// What a file name in the outbox directory is.
enum FileKind<'a> {
    Temp,
    Record(&'a str),
    Variant(&'a str),
    Other,
}

fn classify(name: &str) -> FileKind<'_> {
    if name.ends_with(TMP_SUFFIX) {
        return FileKind::Temp;
    }
    if let Some(id) = name.strip_suffix(".json") {
        return FileKind::Record(id);
    }
    for variant in Variant::ALL {
        if let Some(id) = name.strip_suffix(&format!(".{variant}.jpg")) {
            return FileKind::Variant(id);
        }
    }
    FileKind::Other
}

/// Reads the directory into a known state (see the module docs).
fn scan(dir: &Path) -> Result<Entries, OutboxError> {
    let mut records: Vec<String> = Vec::new();
    let mut variants: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut removed_temp = false;

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            tracing::warn!(name = ?entry.file_name(), "ignoring a non-UTF-8 file in the outbox");
            continue;
        };
        match classify(&name) {
            FileKind::Temp => {
                tracing::warn!(name, "deleting an incomplete outbox write");
                remove_existing(&entry.path())?;
                removed_temp = true;
            }
            FileKind::Record(id) if is_contract_id(id) => records.push(id.to_owned()),
            FileKind::Variant(id) if is_contract_id(id) => {
                variants
                    .entry(id.to_owned())
                    .or_default()
                    .push(name.clone());
            }
            FileKind::Record(_) | FileKind::Variant(_) | FileKind::Other => {
                tracing::warn!(name, "ignoring an unknown file in the outbox");
            }
        }
    }
    if removed_temp {
        sync_dir(dir)?;
    }

    let mut entries = Entries::default();
    for id in records {
        let mut files = variants.remove(&id).unwrap_or_default();
        let record_name = record_file_name(&id);
        let item = fs::read(dir.join(&record_name))
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).map_err(|e| e.to_string()))
            .and_then(|record| {
                if record.format != RECORD_FORMAT {
                    Err(format!("unsupported record format {}", record.format))
                } else if record.item.client_photo_id != id {
                    Err("record names another photo".to_owned())
                } else {
                    Ok(record.item)
                }
            });
        let mut item = match item {
            Ok(item) => item,
            Err(err) => {
                files.push(record_name);
                files.sort();
                tracing::warn!(id, err, "quarantining an unreadable outbox record");
                entries.quarantined.insert(
                    id.clone(),
                    Quarantined {
                        id,
                        reason: format!("record unreadable: {err}"),
                        files,
                    },
                );
                continue;
            }
        };

        let missing: Vec<Variant> = Variant::ALL
            .into_iter()
            .filter(|v| !files.contains(&v.file_name(&id)))
            .collect();
        if !missing.is_empty() {
            let names: Vec<&str> = missing.iter().map(|v| v.as_str()).collect();
            let reason = format!("{} variant file missing", names.join(" and "));
            if item.state
                != (ItemState::NeedsAttention {
                    reason: reason.clone(),
                })
            {
                tracing::warn!(id, reason, "outbox record is missing a variant");
                item.state = ItemState::NeedsAttention { reason };
                persist(dir, &item)?;
            }
        } else if item.state == ItemState::Uploading {
            item.state = ItemState::Queued;
        }
        entries.items.insert(id, item);
    }

    for (id, mut files) in variants {
        files.sort();
        tracing::warn!(id, "quarantining outbox variants without a record");
        entries.quarantined.insert(
            id.clone(),
            Quarantined {
                id,
                reason: "record missing (the enqueue was interrupted)".to_owned(),
                files,
            },
        );
    }
    Ok(entries)
}
