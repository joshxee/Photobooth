//! The outbox's data: what goes in ([`EncodedShot`]), what is kept per shot ([`OutboxItem`]),
//! and the identifier rules shared with the portal contract.

use std::fmt;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::time::{iso_millis, unix_millis};

/// A shot's two booth-made variants (DESIGN D14), produced by the variant encoder (08b) from
/// the in-memory original. The original itself never reaches the outbox.
#[derive(Clone, PartialEq, Eq)]
pub struct EncodedShot {
    /// 480 px long edge, q75, baseline, no metadata.
    pub thumb: Vec<u8>,
    /// 2560 px long edge, q85, baseline, no metadata.
    pub hd: Vec<u8>,
    /// The HD variant's size, orientation applied.
    pub width: u32,
    pub height: u32,
}

impl fmt::Debug for EncodedShot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncodedShot")
            .field("thumb_bytes", &self.thumb.len())
            .field("hd_bytes", &self.hd.len())
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

/// One of the two variants the portal stores per photo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Variant {
    Thumb,
    Hd,
}

impl Variant {
    pub const ALL: [Variant; 2] = [Variant::Thumb, Variant::Hd];

    /// The contract's name (`thumb`, `hd`).
    pub fn as_str(self) -> &'static str {
        match self {
            Variant::Thumb => "thumb",
            Variant::Hd => "hd",
        }
    }

    /// The variant's file in the outbox directory.
    pub fn file_name(self, id: &str) -> String {
        format!("{id}.{}.jpg", self.as_str())
    }
}

impl fmt::Display for Variant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A variant's declaration in the intent: its exact length and lowercase hex sha256.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariantInfo {
    pub bytes: u64,
    pub sha256: String,
}

/// Where an item is in the upload cycle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ItemState {
    /// Waiting for `next_attempt_at`.
    Queued,
    /// Claimed by a drain. Held in memory only: a record on disk is never `Uploading`, so
    /// an item interrupted by a crash comes back `Queued`.
    Uploading,
    /// Stopped until the operator retries or dismisses it (DESIGN §9.3). Never retried
    /// automatically.
    NeedsAttention { reason: String },
}

/// One queued shot. Persisted as `{client_photo_id}.json` next to its two variant files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxItem {
    /// Lowercase UUID v4, made by the booth; the server's idempotency key.
    pub client_photo_id: String,
    /// The event selected when the shot was queued. Switching events later never changes it.
    pub event_id: String,
    pub session_id: String,
    pub shot: u8,
    #[serde(with = "unix_millis")]
    pub captured_at: SystemTime,
    /// The HD variant's size.
    pub width: u32,
    pub height: u32,
    pub thumb: VariantInfo,
    pub hd: VariantInfo,
    pub state: ItemState,
    /// Failed attempts so far; drives the backoff.
    pub attempts: u32,
    /// `hash_mismatch` answers so far (DESIGN §9.3 allows 3 retries).
    pub hash_mismatches: u32,
    #[serde(with = "unix_millis")]
    pub next_attempt_at: SystemTime,
    pub last_error: Option<String>,
}

impl OutboxItem {
    pub fn variant(&self, variant: Variant) -> &VariantInfo {
        match variant {
            Variant::Thumb => &self.thumb,
            Variant::Hd => &self.hd,
        }
    }

    /// `capturedAt` in the contract's form (`2026-10-22T09:30:12.345Z`).
    pub fn captured_at_iso(&self) -> String {
        iso_millis(self.captured_at)
    }

    pub fn record_file_name(&self) -> String {
        record_file_name(&self.client_photo_id)
    }
}

pub(crate) fn record_file_name(id: &str) -> String {
    format!("{id}.json")
}

/// Files found on open that can't be uploaded because their record is missing or unreadable
/// (for example an enqueue killed between the variants and the record). Kept on disk and
/// shown as needs attention: nothing is deleted without the operator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quarantined {
    pub id: String,
    pub reason: String,
    /// File names in the outbox directory.
    pub files: Vec<String>,
}

/// The contract's `Id`: a lowercase hyphenated UUID, versions 1–8, RFC 4122 variant.
pub(crate) fn is_contract_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
    b.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        14 => (b'1'..=b'8').contains(&c),
        19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
        _ => hex(c),
    })
}

/// The contract's `SessionId`: `^[A-Za-z0-9_-]{1,64}$`.
pub(crate) fn is_contract_session_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_ids_match_the_portal_regex() {
        assert!(is_contract_id("019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01"));
        assert!(is_contract_id("5f0c2b1e-8d3a-4c6f-9b2e-7a1d4e6f8c90"));
        assert!(is_contract_id(&uuid::Uuid::new_v4().to_string()));
        for bad in [
            "",
            "019A0B6C-4F00-7A3E-9C41-5B2D8E0F1A01", // uppercase
            "019a0b6c-4f00-0a3e-9c41-5b2d8e0f1a01", // version 0
            "019a0b6c-4f00-7a3e-7c41-5b2d8e0f1a01", // variant
            "019a0b6c4f007a3e9c415b2d8e0f1a01",     // no hyphens
            "019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a0g", // not hex
            "../a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01", // path
        ] {
            assert!(!is_contract_id(bad), "{bad}");
        }
    }

    #[test]
    fn session_ids_match_the_portal_regex() {
        assert!(is_contract_session_id("6a3f1c20-3"));
        assert!(is_contract_session_id(&"a".repeat(64)));
        assert!(!is_contract_session_id(""));
        assert!(!is_contract_session_id(&"a".repeat(65)));
        assert!(!is_contract_session_id("a b"));
        assert!(!is_contract_session_id("a/b"));
    }
}
