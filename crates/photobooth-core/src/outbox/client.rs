//! The seam between the outbox and the portal: a [`PortalClient`] trait (the reqwest client
//! is session 09), its outcomes, and how each contract error maps to what the outbox does
//! (DESIGN §9.3, the error-code table in `wiki/Portal.md`).

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};

use super::item::{OutboxItem, Variant};

/// Talks to the portal's device API. Implementations do the HTTP; the outbox decides what an
/// answer means.
#[async_trait]
pub trait PortalClient: Send + Sync {
    /// `POST /v1/device/photos` for `item` (idempotent on its `client_photo_id`).
    async fn intent(&self, item: &OutboxItem) -> Result<IntentOutcome, PortalError>;

    /// Sends one variant to the URL the intent returned, with `upload.headers` as given.
    async fn upload(
        &self,
        upload: &UploadDescriptor,
        body: Bytes,
    ) -> Result<UploadOutcome, PortalError>;
}

/// The intent's answer (`PhotoIntentResponse`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntentOutcome {
    /// Both variants are stored and the photo is published: nothing to upload.
    Ready,
    /// The server refused a stored variant; re-sending can't help.
    Rejected { reason: String },
    /// Upload these, and only these, variants (the ones the server still needs).
    Pending { uploads: Vec<UploadDescriptor> },
}

/// An opaque upload target (DESIGN §9.4): the client sends `method url` with `headers`
/// exactly as given, so the server can switch to presigned URLs without a booth release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadDescriptor {
    pub variant: Variant,
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    /// The contract's `expiresAt`, as sent.
    pub expires_at: String,
}

/// A successful answer to one variant's PUT.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadOutcome {
    /// 200: this variant is stored, the photo is not READY yet.
    Stored,
    /// 201: this upload completed the photo.
    Ready,
    /// 202: accepted for later processing. The MVP never sends it; it is retried like a
    /// transient error so an asynchronous server path needs no booth release.
    Processing,
}

/// The contract's error codes: a closed set, one HTTP status each
/// (`ERROR_CODES`/`ERROR_STATUS` in `apps/portal/src/shared/schemas.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    EventClosed,
    PhotoLimit,
    UploadExpired,
    TooLarge,
    HashMismatch,
    InvalidImage,
    RateLimited,
    Internal,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 13] = [
        ErrorCode::InvalidRequest,
        ErrorCode::Unauthorized,
        ErrorCode::Forbidden,
        ErrorCode::NotFound,
        ErrorCode::Conflict,
        ErrorCode::EventClosed,
        ErrorCode::PhotoLimit,
        ErrorCode::UploadExpired,
        ErrorCode::TooLarge,
        ErrorCode::HashMismatch,
        ErrorCode::InvalidImage,
        ErrorCode::RateLimited,
        ErrorCode::Internal,
    ];

    /// The HTTP status the server sends this code with.
    pub fn status(self) -> u16 {
        match self {
            ErrorCode::InvalidRequest => 400,
            ErrorCode::Unauthorized => 401,
            ErrorCode::Forbidden => 403,
            ErrorCode::NotFound => 404,
            ErrorCode::Conflict | ErrorCode::EventClosed | ErrorCode::PhotoLimit => 409,
            ErrorCode::UploadExpired => 410,
            ErrorCode::TooLarge => 413,
            ErrorCode::HashMismatch | ErrorCode::InvalidImage => 422,
            ErrorCode::RateLimited => 429,
            ErrorCode::Internal => 500,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::Unauthorized => "unauthorized",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Conflict => "conflict",
            ErrorCode::EventClosed => "event_closed",
            ErrorCode::PhotoLimit => "photo_limit",
            ErrorCode::UploadExpired => "upload_expired",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::HashMismatch => "hash_mismatch",
            ErrorCode::InvalidImage => "invalid_image",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::Internal => "internal",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A failed call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PortalError {
    /// No HTTP answer: DNS, connect, TLS, timeout, a dropped connection.
    Network(String),
    /// An HTTP error status. `code` is the body's `code` when it parsed as the contract's
    /// error shape (a proxy's 502 page has none).
    Http {
        status: u16,
        code: Option<ErrorCode>,
        retry_after: Option<Duration>,
    },
}

impl PortalError {
    /// The error for a contract code, with its own status.
    pub fn code(code: ErrorCode) -> Self {
        PortalError::Http {
            status: code.status(),
            code: Some(code),
            retry_after: None,
        }
    }

    /// The code decides when there is one; otherwise the status alone does.
    pub(crate) fn action(&self) -> Action {
        match *self {
            PortalError::Network(_) => Action::Retry { retry_after: None },
            PortalError::Http {
                code: Some(code),
                retry_after,
                ..
            } => match code {
                ErrorCode::RateLimited | ErrorCode::Internal => Action::Retry { retry_after },
                ErrorCode::UploadExpired => Action::ReIntent,
                ErrorCode::HashMismatch => Action::HashMismatch,
                ErrorCode::InvalidRequest
                | ErrorCode::Unauthorized
                | ErrorCode::Forbidden
                | ErrorCode::NotFound
                | ErrorCode::Conflict
                | ErrorCode::EventClosed
                | ErrorCode::PhotoLimit
                | ErrorCode::TooLarge
                | ErrorCode::InvalidImage => Action::NeedsAttention,
            },
            PortalError::Http {
                status,
                code: None,
                retry_after,
            } => match status {
                408 | 429 | 500..=599 => Action::Retry { retry_after },
                410 => Action::ReIntent,
                _ => Action::NeedsAttention,
            },
        }
    }
}

impl fmt::Display for PortalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PortalError::Network(message) => write!(f, "network error: {message}"),
            PortalError::Http {
                status,
                code: Some(code),
                ..
            } => write!(f, "{code} ({status})"),
            PortalError::Http { status, .. } => write!(f, "HTTP {status}"),
        }
    }
}

impl std::error::Error for PortalError {}

/// What the outbox does with an error (DESIGN §9.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    /// Back off and try again later.
    Retry { retry_after: Option<Duration> },
    /// The upload URL expired: POST the intent again for fresh URLs, now.
    ReIntent,
    /// Retry, at most 3 times, then needs attention.
    HashMismatch,
    /// Stop until the operator acts.
    NeedsAttention,
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::Value;

    use super::*;

    fn contract_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/portal/contract")
    }

    fn read_json(path: PathBuf) -> Value {
        let text =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&text).unwrap()
    }

    /// Every `ErrorBody` fixture's code parses, and its status in the manifest is the one
    /// [`ErrorCode::status`] gives; every code has a fixture. A contract change that adds or
    /// moves a code fails here until the booth's mapping follows.
    #[test]
    fn error_codes_and_statuses_match_the_contract_fixtures() {
        let manifest = read_json(contract_dir().join("manifest.json"));
        let mut seen = Vec::new();
        for (file, entry) in manifest["fixtures"].as_object().unwrap() {
            if entry["schema"] != "ErrorBody" {
                continue;
            }
            let body = read_json(contract_dir().join("fixtures").join(file));
            let code: ErrorCode = serde_json::from_value(body["code"].clone())
                .unwrap_or_else(|e| panic!("{file}: {e}"));
            assert_eq!(
                Some(u64::from(code.status())),
                entry["status"].as_u64(),
                "{file}"
            );
            assert_eq!(body["code"], code.as_str());
            seen.push(code);
        }
        for code in ErrorCode::ALL {
            assert!(seen.contains(&code), "no fixture for {code}");
        }
    }

    fn http(status: u16) -> PortalError {
        PortalError::Http {
            status,
            code: None,
            retry_after: None,
        }
    }

    /// DESIGN §9.3, row by row.
    #[test]
    fn each_error_maps_to_its_design_row() {
        let retry = Action::Retry { retry_after: None };
        let cases: Vec<(PortalError, Action)> = vec![
            (PortalError::Network("reset".into()), retry),
            (PortalError::code(ErrorCode::RateLimited), retry),
            (PortalError::code(ErrorCode::Internal), retry),
            (http(502), retry),
            (http(503), retry),
            (http(429), retry),
            (
                PortalError::code(ErrorCode::UploadExpired),
                Action::ReIntent,
            ),
            (
                PortalError::code(ErrorCode::HashMismatch),
                Action::HashMismatch,
            ),
            (
                PortalError::code(ErrorCode::Unauthorized),
                Action::NeedsAttention,
            ),
            (
                PortalError::code(ErrorCode::Forbidden),
                Action::NeedsAttention,
            ),
            (http(401), Action::NeedsAttention),
            (http(403), Action::NeedsAttention),
            (
                PortalError::code(ErrorCode::EventClosed),
                Action::NeedsAttention,
            ),
            (
                PortalError::code(ErrorCode::PhotoLimit),
                Action::NeedsAttention,
            ),
            (
                PortalError::code(ErrorCode::InvalidImage),
                Action::NeedsAttention,
            ),
            (
                PortalError::code(ErrorCode::Conflict),
                Action::NeedsAttention,
            ),
            (
                PortalError::code(ErrorCode::TooLarge),
                Action::NeedsAttention,
            ),
            (
                PortalError::code(ErrorCode::InvalidRequest),
                Action::NeedsAttention,
            ),
            (
                PortalError::code(ErrorCode::NotFound),
                Action::NeedsAttention,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(error.action(), expected, "{error}");
        }
    }

    #[test]
    fn retry_after_travels_with_the_retry() {
        let after = Some(Duration::from_secs(42));
        for (status, code) in [(429, Some(ErrorCode::RateLimited)), (503, None)] {
            let error = PortalError::Http {
                status,
                code,
                retry_after: after,
            };
            assert_eq!(error.action(), Action::Retry { retry_after: after });
        }
    }

    #[test]
    fn errors_read_well_in_the_operator_list() {
        assert_eq!(
            PortalError::code(ErrorCode::EventClosed).to_string(),
            "event_closed (409)"
        );
        assert_eq!(http(502).to_string(), "HTTP 502");
        assert_eq!(
            PortalError::Network("timed out".into()).to_string(),
            "network error: timed out"
        );
    }
}
