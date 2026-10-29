//! The device API's messages, as serde types (`apps/portal/src/shared/schemas.ts` is the source
//! of truth; `apps/portal/contract/fixtures/device.*.json` are the shared examples).
//!
//! Contract rules (PROGRESS.md, session 03): optional fields are omitted, never `null`, except
//! `galleryUrl`, which is always present and may be `null`; times are `toISOString()` form;
//! the upload `headers` is an open map. Responses do not `deny_unknown_fields`, so a deployed
//! booth survives a server that adds a field.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use super::gallery::GalleryUrl;

/// The device credential: a bearer secret, returned once by enrolment.
///
/// It has no `Display`, and its `Debug` is redacted, so it can't end up in a log line or an
/// error message by accident. It is serialized only into the enrolment response type (for the
/// fixture test) and the credential file.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceCredential(String);

impl DeviceCredential {
    #[cfg(test)]
    pub fn new(secret: impl Into<String>) -> Self {
        Self(secret.into())
    }

    /// The secret, for the `Authorization` header and the credential file only.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// The contract's shape: 43 base64url characters (256 bits).
    pub fn is_well_formed(&self) -> bool {
        self.0.len() == 43
            && self
                .0
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}

impl fmt::Debug for DeviceCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceCredential(<redacted>)")
    }
}

/// `POST /v1/device/enrol`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrolRequest {
    pub code: String,
    pub name: String,
    pub app_version: String,
}

/// 201 from enrolment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrolResponse {
    pub device_id: String,
    /// What the server stored (the name the booth sent).
    pub name: String,
    pub credential: DeviceCredential,
}

/// One row of `GET /v1/device/events`: an event that accepts uploads now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEvent {
    pub id: String,
    pub name: String,
    pub venue: String,
    pub timezone: String,
    /// The event's start date in its own time zone (`YYYY-MM-DD`).
    pub local_date: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceEventsResponse {
    pub events: Vec<DeviceEvent>,
}

/// `GET /v1/device/events/{id}`. Any non-deleted event, so check `upload_status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEventDetail {
    pub id: String,
    pub name: String,
    pub venue: String,
    pub timezone: String,
    pub local_date: String,
    /// `DRAFT`, `OPEN` or `CLOSED`. Kept as text: a new status must not break the booth.
    pub upload_status: String,
    /// `HIDDEN`, `LIVE` or `SUSPENDED`.
    pub gallery_status: String,
    /// Present (with its `#k=` token) only while the gallery is LIVE.
    pub gallery_url: Option<GalleryUrl>,
}

impl DeviceEventDetail {
    pub const OPEN: &'static str = "OPEN";

    pub fn accepts_uploads(&self) -> bool {
        self.upload_status == Self::OPEN
    }
}

/// `{bytes, sha256}` of one variant, as declared in the intent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VariantDeclaration {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentVariants {
    pub thumb: VariantDeclaration,
    pub hd: VariantDeclaration,
}

/// `POST /v1/device/photos`, the upload intent (DESIGN §9.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoIntentRequest {
    pub event_id: String,
    pub client_photo_id: String,
    pub session_id: String,
    pub shot: u8,
    /// UTC, exactly three fractional digits and `Z`.
    pub captured_at: String,
    /// The HD variant's size, orientation applied.
    pub width: u32,
    pub height: u32,
    pub variants: IntentVariants,
}

/// Where and how to send one variant. Sent exactly as given (DESIGN §9.4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTarget {
    pub method: String,
    pub url: String,
    /// An open map: a later server may add headers (presigned URLs) without a booth release.
    pub headers: BTreeMap<String, String>,
    pub expires_at: String,
}

/// The variants the server still needs; absent ones are already stored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadTargets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<UploadTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hd: Option<UploadTarget>,
}

/// 200 from the intent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "UPPERCASE")]
pub enum PhotoIntentResponse {
    #[serde(rename_all = "camelCase")]
    Ready { photo_id: String },
    #[serde(rename_all = "camelCase")]
    Pending {
        photo_id: String,
        uploads: UploadTargets,
    },
    #[serde(rename_all = "camelCase")]
    Rejected { photo_id: String, reason: String },
}

/// A successful answer to one variant's PUT.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "UPPERCASE")]
pub enum UploadResponse {
    /// 200: this variant is stored, the photo is not READY yet.
    #[serde(rename_all = "camelCase")]
    Stored { photo_id: String, variant: String },
    /// 201: this upload completed the photo.
    #[serde(rename_all = "camelCase")]
    Ready { photo_id: String },
    /// 202: accepted for later processing (never sent by the MVP).
    #[serde(rename_all = "camelCase")]
    Processing { photo_id: String },
}

/// Every error response: `code` comes from a closed set, kept as text here so an unknown code
/// still parses (it maps to no `ErrorCode`, and the status decides).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub correlation_id: String,
}

#[cfg(test)]
pub(crate) mod tests {
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    use super::*;

    /// Every `device.*` fixture, compiled in: a fixture added to the contract without a line
    /// here fails `every_device_fixture_is_covered`.
    const DEVICE_FIXTURES: &[(&str, &str)] = &[
        (
            "device.enrol-request.valid.json",
            include_str!("../../../../portal/contract/fixtures/device.enrol-request.valid.json"),
        ),
        (
            "device.enrol-response.valid.json",
            include_str!("../../../../portal/contract/fixtures/device.enrol-response.valid.json"),
        ),
        (
            "device.event-detail.hidden.json",
            include_str!("../../../../portal/contract/fixtures/device.event-detail.hidden.json"),
        ),
        (
            "device.event-detail.live.json",
            include_str!("../../../../portal/contract/fixtures/device.event-detail.live.json"),
        ),
        (
            "device.events-response.empty.json",
            include_str!("../../../../portal/contract/fixtures/device.events-response.empty.json"),
        ),
        (
            "device.events-response.valid.json",
            include_str!("../../../../portal/contract/fixtures/device.events-response.valid.json"),
        ),
        (
            "device.intent-request.valid.json",
            include_str!("../../../../portal/contract/fixtures/device.intent-request.valid.json"),
        ),
        (
            "device.intent-response.conflict.json",
            include_str!(
                "../../../../portal/contract/fixtures/device.intent-response.conflict.json"
            ),
        ),
        (
            "device.intent-response.pending-both.json",
            include_str!(
                "../../../../portal/contract/fixtures/device.intent-response.pending-both.json"
            ),
        ),
        (
            "device.intent-response.pending-hd.json",
            include_str!(
                "../../../../portal/contract/fixtures/device.intent-response.pending-hd.json"
            ),
        ),
        (
            "device.intent-response.ready.json",
            include_str!("../../../../portal/contract/fixtures/device.intent-response.ready.json"),
        ),
        (
            "device.intent-response.rejected.json",
            include_str!(
                "../../../../portal/contract/fixtures/device.intent-response.rejected.json"
            ),
        ),
        (
            "device.upload-response.processing.json",
            include_str!(
                "../../../../portal/contract/fixtures/device.upload-response.processing.json"
            ),
        ),
        (
            "device.upload-response.ready.json",
            include_str!("../../../../portal/contract/fixtures/device.upload-response.ready.json"),
        ),
        (
            "device.upload-response.stored.json",
            include_str!("../../../../portal/contract/fixtures/device.upload-response.stored.json"),
        ),
    ];

    const MANIFEST: &str = include_str!("../../../../portal/contract/manifest.json");

    pub(crate) fn fixture(name: &str) -> &'static str {
        DEVICE_FIXTURES
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("no fixture {name}"))
            .1
    }

    /// Parses `text` as `T`, serializes it back, and requires the same JSON: a field the Rust
    /// type lacks, renames, or writes differently (a `null` for an omitted optional) fails.
    fn round_trip<T: DeserializeOwned + Serialize>(name: &str, text: &str) {
        let parsed: T = serde_json::from_str(text).unwrap_or_else(|e| panic!("{name}: {e}"));
        let back = serde_json::to_value(&parsed).unwrap();
        let original: Value = serde_json::from_str(text).unwrap();
        assert_eq!(back, original, "{name} does not round-trip");
    }

    /// The manifest's schema name → the Rust type that must round-trip it.
    fn round_trip_as(schema: &str, name: &str, text: &str) {
        match schema {
            "EnrolRequest" => round_trip::<EnrolRequest>(name, text),
            "EnrolResponse" => round_trip::<EnrolResponse>(name, text),
            "DeviceEventsResponse" => round_trip::<DeviceEventsResponse>(name, text),
            "DeviceEventDetail" => round_trip::<DeviceEventDetail>(name, text),
            "PhotoIntentRequest" => round_trip::<PhotoIntentRequest>(name, text),
            "PhotoIntentResponse" => round_trip::<PhotoIntentResponse>(name, text),
            "UploadResponse" => round_trip::<UploadResponse>(name, text),
            "ErrorBody" => round_trip::<ErrorBody>(name, text),
            other => panic!("{name}: no Rust type for schema {other}"),
        }
    }

    #[test]
    fn every_device_fixture_round_trips_through_its_rust_type() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        for (name, text) in DEVICE_FIXTURES {
            let entry = &manifest["fixtures"][*name];
            let schema = entry["schema"]
                .as_str()
                .unwrap_or_else(|| panic!("{name} is not in the manifest"));
            round_trip_as(schema, name, text);
        }
    }

    #[test]
    fn every_device_fixture_is_covered() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let listed: Vec<&str> = manifest["fixtures"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .filter(|n| n.starts_with("device."))
            .collect();
        let compiled: Vec<&str> = DEVICE_FIXTURES.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            compiled, listed,
            "DEVICE_FIXTURES must list every device fixture"
        );

        // And the directory has nothing the manifest misses.
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../portal/contract/fixtures");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("device."))
            .collect();
        on_disk.sort();
        assert_eq!(on_disk, listed);
    }

    #[test]
    fn requests_refuse_unknown_fields_but_responses_tolerate_them() {
        let request = r#"{"code":"X","name":"B","appVersion":"1","extra":1}"#;
        assert!(serde_json::from_str::<EnrolRequest>(request).is_err());

        let mut detail: Value =
            serde_json::from_str(fixture("device.event-detail.live.json")).unwrap();
        detail["somethingNew"] = Value::Bool(true);
        let parsed: DeviceEventDetail = serde_json::from_value(detail).unwrap();
        assert_eq!(parsed.name, "Smith wedding");
    }

    #[test]
    fn intent_responses_parse_into_the_right_shape() {
        let pending: PhotoIntentResponse =
            serde_json::from_str(fixture("device.intent-response.pending-hd.json")).unwrap();
        let PhotoIntentResponse::Pending { uploads, .. } = pending else {
            panic!("pending")
        };
        assert!(uploads.thumb.is_none());
        let hd = uploads.hd.expect("hd still needed");
        assert_eq!(hd.method, "PUT");
        assert_eq!(hd.headers["Content-Type"], "image/jpeg");

        let rejected: PhotoIntentResponse =
            serde_json::from_str(fixture("device.intent-response.rejected.json")).unwrap();
        assert!(
            matches!(rejected, PhotoIntentResponse::Rejected { reason, .. } if reason == "segment 0xe1 not allowed")
        );
    }

    #[test]
    fn the_gallery_url_is_null_not_omitted_and_status_decides_selection() {
        let hidden: DeviceEventDetail =
            serde_json::from_str(fixture("device.event-detail.hidden.json")).unwrap();
        assert_eq!(hidden.gallery_url, None);
        assert!(hidden.accepts_uploads());
        let json = serde_json::to_value(&hidden).unwrap();
        assert_eq!(json["galleryUrl"], Value::Null);
        let closed = DeviceEventDetail {
            upload_status: "CLOSED".into(),
            ..hidden
        };
        assert!(!closed.accepts_uploads());
    }

    #[test]
    fn the_credential_never_prints() {
        let response: EnrolResponse =
            serde_json::from_str(fixture("device.enrol-response.valid.json")).unwrap();
        let secret = response.credential.expose().to_owned();
        assert!(response.credential.is_well_formed());
        assert!(!format!("{response:?}").contains(&secret));
        assert!(!DeviceCredential::new("short").is_well_formed());
        assert!(!DeviceCredential::new("a".repeat(42) + "=").is_well_formed());
    }
}
