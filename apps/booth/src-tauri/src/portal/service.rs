//! Enrolment and event selection (DESIGN §10 items 1–2), without the settings: `AppState`
//! stores what these return. Errors are written for the operator.

use std::sync::OnceLock;

use photobooth_core::outbox::{is_contract_id, ErrorCode, PortalError};
use photobooth_core::SelectedEvent;

use super::client::{http_client, HttpPortalClient, PortalOrigin};
use super::credential::{CredentialStore, StoredCredential};
use super::types::DeviceEvent;
use crate::dto::CommandError;

/// How this build talks to portals.
#[derive(Clone, Debug)]
pub struct PortalConfig {
    /// Sent as `appVersion` and `X-App-Version`.
    pub app_version: String,
    /// Plain http to a private IPv4 address (a dev PC on the LAN). Debug builds only.
    pub allow_lan_http: bool,
    /// What the enrolment form starts with when no portal was ever set.
    pub default_url: String,
}

impl PortalConfig {
    /// This build's defaults: debug builds point at local `wrangler dev`; release builds have
    /// no portal until the operator types one (staging and production hosts come with 07/18).
    pub fn for_this_build() -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            allow_lan_http: cfg!(debug_assertions),
            default_url: option_env!("PHOTOBOOTH_PORTAL_URL")
                .unwrap_or(if cfg!(debug_assertions) {
                    "http://photos.localhost:8787"
                } else {
                    ""
                })
                .to_owned(),
        }
    }
}

/// The contract's `Name`: 1–100 characters, and printable.
const MAX_NAME_CHARS: usize = 100;
/// The contract's enrolment code field is at most 32 characters (the code itself is 8).
const MAX_CODE_CHARS: usize = 32;

pub struct PortalService {
    credentials: CredentialStore,
    config: PortalConfig,
    http: OnceLock<Result<reqwest::Client, String>>,
    /// Enrol, unenrol and select run one at a time, so a double tap can't enrol twice.
    ops: tokio::sync::Mutex<()>,
}

impl PortalService {
    pub fn new(credentials: CredentialStore, config: PortalConfig) -> Self {
        Self {
            credentials,
            config,
            http: OnceLock::new(),
            ops: tokio::sync::Mutex::new(()),
        }
    }

    pub fn config(&self) -> &PortalConfig {
        &self.config
    }

    /// The stored enrolment, if any. A damaged file is an error.
    pub fn enrolment(&self) -> Result<Option<StoredCredential>, CommandError> {
        self.credentials.load().map_err(|err| {
            CommandError::new(format!(
                "The portal enrolment on this booth is damaged ({err}). Unenrol, then enrol again."
            ))
        })
    }

    /// Swaps a one-time code for the credential and stores it. Refused while enrolled: the
    /// operator unenrols first, so a credential is never replaced by accident.
    pub async fn enrol(
        &self,
        url: &str,
        code: &str,
        name: &str,
    ) -> Result<StoredCredential, CommandError> {
        let _op = self.ops.lock().await;
        if self.enrolment()?.is_some() {
            return Err(CommandError::new(
                "This booth is already enrolled. Unenrol it first.",
            ));
        }
        let origin =
            PortalOrigin::parse(url, self.config.allow_lan_http).map_err(CommandError::new)?;
        let name = name.trim();
        if name.is_empty()
            || name.chars().count() > MAX_NAME_CHARS
            || name.chars().any(char::is_control)
        {
            return Err(CommandError::new(format!(
                "Give the booth a name of 1 to {MAX_NAME_CHARS} characters."
            )));
        }
        let code = code.trim();
        if code.is_empty() || code.chars().count() > MAX_CODE_CHARS {
            return Err(CommandError::new(
                "Enter the enrolment code from the admin portal.",
            ));
        }
        let client = HttpPortalClient::new(self.http()?, origin.clone(), None, self.app_version());
        let enrolled = client
            .enrol(code, name)
            .await
            .map_err(|err| explain(&err, Call::Enrol))?;
        let stored = StoredCredential {
            portal_url: origin.as_str().to_owned(),
            device_id: enrolled.device_id,
            device_name: enrolled.name,
            credential: enrolled.credential,
        };
        self.credentials
            .save(&stored)
            .map_err(|err| CommandError::new(format!("Couldn't save the enrolment: {err}")))?;
        tracing::info!(
            portal = %origin.host(),
            device_id = %stored.device_id,
            "enrolled with the portal"
        );
        Ok(stored)
    }

    /// Forgets the credential. The portal still lists the device until an admin revokes it.
    pub async fn unenrol(&self) -> Result<(), CommandError> {
        let _op = self.ops.lock().await;
        self.credentials
            .delete()
            .map_err(|err| CommandError::new(format!("Couldn't remove the enrolment: {err}")))?;
        tracing::info!("unenrolled from the portal");
        Ok(())
    }

    /// The events that accept uploads now.
    pub async fn events(&self) -> Result<Vec<DeviceEvent>, CommandError> {
        self.client()?
            .events()
            .await
            .map_err(|err| explain(&err, Call::Device))
    }

    /// Re-fetches event `id` and returns it for selection if it accepts uploads now.
    pub async fn open_event(&self, id: &str) -> Result<SelectedEvent, CommandError> {
        let _op = self.ops.lock().await;
        if !is_contract_id(id) {
            return Err(CommandError::new("That isn't an event from the portal."));
        }
        let detail = self
            .client()?
            .event(id)
            .await
            .map_err(|err| explain(&err, Call::Event))?;
        if detail.id != id {
            return Err(CommandError::new("The portal sent a different event."));
        }
        if !detail.accepts_uploads() {
            return Err(CommandError::new(format!(
                "\"{}\" isn't open for uploads (it is {}). Open it in the admin portal first.",
                detail.name,
                detail.upload_status.to_lowercase()
            )));
        }
        Ok(SelectedEvent {
            id: detail.id,
            name: detail.name,
            local_date: detail.local_date,
        })
    }

    /// A client with the stored credential, for the device API (session 10's upload loop
    /// adds the outbox depth).
    pub fn client(&self) -> Result<HttpPortalClient, CommandError> {
        let stored = self
            .enrolment()?
            .ok_or_else(|| CommandError::new("This booth isn't enrolled with a portal."))?;
        // Stored by `enrol`, so it parses; re-checked in case the file was edited.
        let origin =
            PortalOrigin::parse(&stored.portal_url, self.config.allow_lan_http).map_err(|_| {
                CommandError::new(
                    "The stored portal address isn't valid. Unenrol, then enrol again.",
                )
            })?;
        Ok(HttpPortalClient::new(
            self.http()?,
            origin,
            Some(stored.credential),
            self.app_version(),
        ))
    }

    fn app_version(&self) -> String {
        self.config.app_version.clone()
    }

    fn http(&self) -> Result<reqwest::Client, CommandError> {
        self.http
            .get_or_init(http_client)
            .clone()
            .map_err(CommandError::new)
    }
}

/// Which call failed, for wording a 401 or a 404.
#[derive(Clone, Copy)]
enum Call {
    Enrol,
    Device,
    Event,
}

/// The operator's version of a portal error.
fn explain(err: &PortalError, call: Call) -> CommandError {
    let (status, code, retry_after) = match err {
        PortalError::Network(message) => {
            return CommandError::new(format!(
                "Can't reach the portal ({message}). Check the Wi-Fi and the portal address."
            ));
        }
        PortalError::Http {
            status,
            code,
            retry_after,
        } => (*status, *code, *retry_after),
    };
    let message = match (code, status, call) {
        (_, 401, Call::Enrol) => "That enrolment code isn't valid. Codes work once and expire \
             after 10 minutes: create a new one in the admin portal."
            .to_owned(),
        (_, 401, _) => "The portal no longer accepts this booth (it may have been revoked). \
             Unenrol, then enrol again with a new code."
            .to_owned(),
        (Some(ErrorCode::RateLimited), _, _) | (_, 429, _) => match retry_after {
            Some(after) => format!(
                "Too many attempts. Try again in {} seconds.",
                after.as_secs()
            ),
            None => "Too many attempts. Try again in a minute.".to_owned(),
        },
        (_, 404, Call::Event) => "That event no longer exists.".to_owned(),
        (Some(ErrorCode::InvalidRequest), _, Call::Enrol) => {
            "The portal refused the code or the booth name.".to_owned()
        }
        _ => format!("The portal answered {err}."),
    };
    CommandError::new(message)
}

#[cfg(test)]
mod tests {
    use super::super::test_server::{Canned, MockPortal};
    use super::super::types::tests::fixture;
    use super::*;

    const CREDENTIAL: &str = "ZXhhbXBsZS1jcmVkZW50aWFsLW5vdC1yZWFsLTAwMDA";
    const EVENT_ID: &str = "019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01";

    fn config() -> PortalConfig {
        PortalConfig {
            app_version: "0.4.0".into(),
            allow_lan_http: false,
            default_url: String::new(),
        }
    }

    fn service(dir: &tempfile::TempDir) -> PortalService {
        PortalService::new(
            CredentialStore::new(dir.path().join("portal-credential.json")),
            config(),
        )
    }

    /// A portal that answers each device route from its fixture (event detail: `detail`).
    async fn portal(detail: &'static str) -> MockPortal {
        MockPortal::start(move |r| match (r.method.as_str(), r.target.as_str()) {
            ("POST", "/v1/device/enrol") => {
                Canned::json(201, fixture("device.enrol-response.valid.json"))
            }
            ("GET", "/v1/device/events") => {
                Canned::json(200, fixture("device.events-response.valid.json"))
            }
            ("GET", _) => Canned::json(200, detail),
            _ => Canned::json(404, "{}"),
        })
        .await
    }

    #[tokio::test]
    async fn enrolment_stores_the_credential_bound_to_the_portal() {
        let dir = tempfile::tempdir().unwrap();
        let portal = portal(fixture("device.event-detail.live.json")).await;
        let service = service(&dir);
        let stored = service
            .enrol(&format!("{}/", portal.base), " 7k3m-9q2z ", "  Booth 1 ")
            .await
            .unwrap();
        assert_eq!(stored.portal_url, portal.base);
        assert_eq!(stored.device_name, "Booth 1");
        assert_eq!(stored.credential.expose(), CREDENTIAL);
        assert_eq!(service.enrolment().unwrap(), Some(stored));
        // Trimmed, and otherwise sent as typed: the server normalises the code.
        let body = portal.requests()[0].json();
        assert_eq!(body["code"], "7k3m-9q2z");
        assert_eq!(body["name"], "Booth 1");
        assert_eq!(body["appVersion"], "0.4.0");
    }

    #[tokio::test]
    async fn enrolling_twice_is_refused_without_a_request() {
        let dir = tempfile::tempdir().unwrap();
        let portal = portal(fixture("device.event-detail.live.json")).await;
        let service = service(&dir);
        service
            .enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        let err = service
            .enrol(&portal.base, "CODE", "Booth 2")
            .await
            .unwrap_err();
        assert!(err.0.contains("already enrolled"), "{err}");
        assert_eq!(portal.requests().len(), 1);
    }

    #[tokio::test]
    async fn bad_enrolment_input_never_reaches_the_portal() {
        let dir = tempfile::tempdir().unwrap();
        let portal = portal(fixture("device.event-detail.live.json")).await;
        let service = service(&dir);
        let long_name = "x".repeat(101);
        for (url, code, name) in [
            ("http://photos.example.invalid", "CODE", "Booth 1"),
            ("http://192.168.1.20:8787", "CODE", "Booth 1"),
            (portal.base.as_str(), "", "Booth 1"),
            (portal.base.as_str(), "   ", "Booth 1"),
            (portal.base.as_str(), &"C".repeat(33), "Booth 1"),
            (portal.base.as_str(), "CODE", ""),
            (portal.base.as_str(), "CODE", &long_name),
            (portal.base.as_str(), "CODE", "Booth\n1"),
        ] {
            assert!(
                service.enrol(url, code, name).await.is_err(),
                "{url} {code:?} {name:?}"
            );
        }
        assert!(portal.requests().is_empty());
        assert_eq!(service.enrolment().unwrap(), None);
    }

    #[tokio::test]
    async fn a_refused_code_is_explained_and_nothing_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let portal = MockPortal::start(|_| {
            Canned::json(
                401,
                include_str!("../../../../portal/contract/fixtures/error.body.unauthorized.json"),
            )
        })
        .await;
        let service = service(&dir);
        let err = service
            .enrol(&portal.base, "WRONG", "Booth 1")
            .await
            .unwrap_err();
        assert!(err.0.contains("enrolment code isn't valid"), "{err}");
        assert_eq!(service.enrolment().unwrap(), None);
    }

    #[tokio::test]
    async fn an_unreachable_portal_is_explained() {
        let dir = tempfile::tempdir().unwrap();
        let err = service(&dir)
            .enrol("http://127.0.0.1:9", "CODE", "Booth 1")
            .await
            .unwrap_err();
        assert!(err.0.starts_with("Can't reach the portal"), "{err}");
    }

    #[tokio::test]
    async fn events_need_an_enrolment_and_use_it() {
        let dir = tempfile::tempdir().unwrap();
        let portal = portal(fixture("device.event-detail.live.json")).await;
        let service = service(&dir);
        let err = service.events().await.unwrap_err();
        assert!(err.0.contains("isn't enrolled"), "{err}");

        service
            .enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        let events = service.events().await.unwrap();
        assert_eq!(events.len(), 2);
        let request = portal.requests().pop().unwrap();
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {CREDENTIAL}").as_str())
        );
    }

    #[tokio::test]
    async fn only_an_open_event_can_be_selected() {
        let dir = tempfile::tempdir().unwrap();
        let open = portal(fixture("device.event-detail.hidden.json")).await;
        let service = service(&dir);
        service.enrol(&open.base, "CODE", "Booth 1").await.unwrap();
        let selected = service.open_event(EVENT_ID).await.unwrap();
        assert_eq!(
            selected,
            SelectedEvent {
                id: EVENT_ID.into(),
                name: "Smith wedding".into(),
                local_date: "2026-10-22".into(),
            }
        );
        assert_eq!(
            open.requests().last().unwrap().target,
            format!("/v1/device/events/{EVENT_ID}")
        );

        // The same service, re-pointed at a portal where the event has closed since.
        let closed_detail = fixture("device.event-detail.hidden.json")
            .replace("\"OPEN\"", "\"CLOSED\"")
            .leak();
        let closed = portal(closed_detail).await;
        let mut stored = service.enrolment().unwrap().unwrap();
        stored.portal_url = closed.base.clone();
        service.credentials.save(&stored).unwrap();
        let err = service.open_event(EVENT_ID).await.unwrap_err();
        assert!(
            err.0.contains("isn't open for uploads (it is closed)"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn selection_refuses_a_malformed_id_a_missing_event_and_a_swapped_one() {
        let dir = tempfile::tempdir().unwrap();
        let other = fixture("device.event-detail.live.json")
            .replace(EVENT_ID, "019a0b6d-2e10-7b4f-8d52-6c3e9f102b02")
            .leak();
        let portal = MockPortal::start(move |r| match r.target.as_str() {
            "/v1/device/enrol" => Canned::json(201, fixture("device.enrol-response.valid.json")),
            t if t.ends_with("1a01") => Canned::json(200, other),
            _ => Canned::json(
                404,
                include_str!("../../../../portal/contract/fixtures/error.body.not_found.json"),
            ),
        })
        .await;
        let service = service(&dir);
        service
            .enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();

        let err = service.open_event("../enrol").await.unwrap_err();
        assert!(err.0.contains("isn't an event"), "{err}");
        assert_eq!(portal.requests().len(), 1, "no request for a malformed ID");

        let err = service
            .open_event("019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a02")
            .await
            .unwrap_err();
        assert!(err.0.contains("no longer exists"), "{err}");

        let err = service.open_event(EVENT_ID).await.unwrap_err();
        assert!(err.0.contains("different event"), "{err}");
    }

    #[tokio::test]
    async fn a_revoked_booth_is_told_to_enrol_again() {
        let dir = tempfile::tempdir().unwrap();
        let portal = MockPortal::start(|r| match r.target.as_str() {
            "/v1/device/enrol" => Canned::json(201, fixture("device.enrol-response.valid.json")),
            _ => Canned::json(
                401,
                include_str!("../../../../portal/contract/fixtures/error.body.unauthorized.json"),
            ),
        })
        .await;
        let service = service(&dir);
        service
            .enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        let err = service.events().await.unwrap_err();
        assert!(err.0.contains("Unenrol, then enrol again"), "{err}");
    }

    #[tokio::test]
    async fn rate_limiting_says_how_long_to_wait() {
        let dir = tempfile::tempdir().unwrap();
        let portal = MockPortal::start(|_| {
            Canned::json(
                429,
                include_str!("../../../../portal/contract/fixtures/error.body.rate_limited.json"),
            )
            .with_header("Retry-After", "60")
        })
        .await;
        let err = service(&dir)
            .enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap_err();
        assert_eq!(err.0, "Too many attempts. Try again in 60 seconds.");
    }

    #[tokio::test]
    async fn unenrolling_deletes_the_credential() {
        let dir = tempfile::tempdir().unwrap();
        let portal = portal(fixture("device.event-detail.live.json")).await;
        let service = service(&dir);
        service
            .enrol(&portal.base, "CODE", "Booth 1")
            .await
            .unwrap();
        service.unenrol().await.unwrap();
        assert_eq!(service.enrolment().unwrap(), None);
        assert!(!dir.path().join("portal-credential.json").exists());
        service.unenrol().await.unwrap();
    }

    #[test]
    fn this_build_points_debug_builds_at_local_wrangler() {
        let config = PortalConfig::for_this_build();
        assert_eq!(config.app_version, env!("CARGO_PKG_VERSION"));
        if option_env!("PHOTOBOOTH_PORTAL_URL").is_none() && cfg!(debug_assertions) {
            assert_eq!(config.default_url, "http://photos.localhost:8787");
            assert!(config.allow_lan_http);
        }
    }
}
