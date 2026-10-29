//! `HttpPortalClient`: the device API over reqwest (DESIGN §8, §9).
//!
//! - The bearer goes only to the enrolled portal's origin, and only on the authenticated device
//!   routes. Enrolment and the upload PUTs never carry it; a PUT sends exactly the headers the
//!   intent returned (DESIGN §9.4).
//! - No redirects are followed: the API never redirects, and a redirect is where a credential
//!   or a signed URL would leak to another host.
//! - Error messages never contain a URL (the PUT URLs carry a signature).
//! - TLS is rustls on `ring` with the Mozilla roots (webpki-roots), so it works the same on the
//!   tablet and the PC without the platform's trust store.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use photobooth_core::outbox::{
    is_contract_id, ErrorCode, IntentOutcome, OutboxItem, PortalClient, PortalError,
    UploadDescriptor, UploadOutcome, Variant,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Method, RequestBuilder, Response, StatusCode, Url};

use super::types::{
    DeviceCredential, DeviceEvent, DeviceEventDetail, DeviceEventsResponse, EnrolRequest,
    EnrolResponse, ErrorBody, IntentVariants, PhotoIntentRequest, PhotoIntentResponse,
    UploadResponse, UploadTarget, VariantDeclaration,
};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A JSON call, end to end.
pub const API_TIMEOUT: Duration = Duration::from_secs(30);
/// One variant's PUT: up to 3 MB on venue Wi-Fi.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// No device response comes near this (100 events are about 25 KB).
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// The contract's device headers (`DEVICE_HEADERS` in `schemas.ts`).
pub const OUTBOX_DEPTH_HEADER: &str = "x-outbox-depth";
pub const APP_VERSION_HEADER: &str = "x-app-version";

/// Builds the shared HTTP client. It holds no credential, so one serves every portal.
pub fn http_client() -> Result<reqwest::Client, String> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("TLS setup failed: {e}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("photobooth/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP client setup failed: {}", describe(&e)))
}

/// A portal's origin (`scheme://host[:port]`), checked: http(s), a host, nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortalOrigin(Url);

impl PortalOrigin {
    /// Parses what the operator typed. Plain `http` is allowed for loopback and `*.localhost`
    /// (local `wrangler dev`), and, when `allow_lan_http` is set (debug builds), for private
    /// IPv4 addresses so the tablet can reach a dev PC. Everything else must be `https`.
    pub fn parse(input: &str, allow_lan_http: bool) -> Result<Self, String> {
        let url = Url::parse(input.trim()).map_err(|_| "enter the portal address as https://…")?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err("the portal address must not contain a user name or password".into());
        }
        if url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
            return Err("enter only the portal address, without a path".into());
        }
        let host = url
            .host_str()
            .ok_or("the portal address needs a host name")?;
        match url.scheme() {
            "https" => {}
            "http" if is_loopback(host) || (allow_lan_http && is_private(host)) => {}
            "http" => return Err("the portal address must start with https://".into()),
            _ => return Err("enter the portal address as https://…".into()),
        }
        Ok(Self(url))
    }

    /// `scheme://host[:port]`, no trailing slash.
    pub fn as_str(&self) -> &str {
        self.0.as_str().trim_end_matches('/')
    }

    /// `host[:port]`, for the operator status.
    pub fn host(&self) -> String {
        match self.0.port() {
            Some(port) => format!("{}:{port}", self.0.host_str().unwrap_or_default()),
            None => self.0.host_str().unwrap_or_default().to_owned(),
        }
    }

    fn url(&self, path: &str) -> Url {
        self.0.join(path).expect("a path joins onto an origin")
    }

    pub(crate) fn is_same_origin(&self, url: &Url) -> bool {
        url.origin() == self.0.origin()
    }
}

/// `host` as `Url::host_str` gives it: lowercase, IPv6 in brackets.
fn is_loopback(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

fn is_private(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>()
        .is_ok_and(|ip| ip.is_private() || ip.is_link_local())
}

/// Where `X-Outbox-Depth` comes from: the number of shots waiting to upload.
pub type OutboxDepth = Arc<dyn Fn() -> usize + Send + Sync>;

/// The device API for one portal, optionally with the device's credential.
pub struct HttpPortalClient {
    http: reqwest::Client,
    origin: PortalOrigin,
    credential: Option<DeviceCredential>,
    app_version: String,
    outbox_depth: OutboxDepth,
}

impl HttpPortalClient {
    pub fn new(
        http: reqwest::Client,
        origin: PortalOrigin,
        credential: Option<DeviceCredential>,
        app_version: impl Into<String>,
        outbox_depth: OutboxDepth,
    ) -> Self {
        Self {
            http,
            origin,
            credential,
            app_version: app_version.into(),
            outbox_depth,
        }
    }

    /// The portal this client talks to.
    pub fn origin(&self) -> &PortalOrigin {
        &self.origin
    }

    /// `POST /v1/device/enrol`: swaps a one-time code for the credential. No bearer.
    pub async fn enrol(&self, code: &str, name: &str) -> Result<EnrolResponse, PortalError> {
        let body = EnrolRequest {
            code: code.to_owned(),
            name: name.to_owned(),
            app_version: self.app_version.clone(),
        };
        let request = self
            .http
            .post(self.origin.url("/v1/device/enrol"))
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&body).expect("serializable"))
            .timeout(API_TIMEOUT);
        let (_, body) = self.send(request).await?;
        let response: EnrolResponse = parse(&body)?;
        if !response.credential.is_well_formed() {
            return Err(unexpected());
        }
        Ok(response)
    }

    /// `GET /v1/device/events`: the events that accept uploads now.
    pub async fn events(&self) -> Result<Vec<DeviceEvent>, PortalError> {
        let url = self.origin.url("/v1/device/events");
        let (_, body) = self.send(self.authed(Method::GET, url)?).await?;
        Ok(parse::<DeviceEventsResponse>(&body)?.events)
    }

    /// `GET /v1/device/events/{id}`: any event that isn't deleted, whatever its status.
    pub async fn event(&self, id: &str) -> Result<DeviceEventDetail, PortalError> {
        if !is_contract_id(id) {
            return Err(PortalError::code(ErrorCode::NotFound));
        }
        let url = self.origin.url(&format!("/v1/device/events/{id}"));
        let (_, body) = self.send(self.authed(Method::GET, url)?).await?;
        parse(&body)
    }

    /// A request to the portal with the bearer and the device headers. Refuses any URL outside
    /// the enrolled origin, and answers 401 when there is no credential (not enrolled).
    fn authed(&self, method: Method, url: Url) -> Result<RequestBuilder, PortalError> {
        let credential = self
            .credential
            .as_ref()
            .ok_or(PortalError::code(ErrorCode::Unauthorized))?;
        if !self.origin.is_same_origin(&url) {
            return Err(PortalError::Network(
                "refused to send the device credential to another origin".into(),
            ));
        }
        let mut bearer = HeaderValue::from_str(&format!("Bearer {}", credential.expose()))
            .map_err(|_| PortalError::code(ErrorCode::Unauthorized))?;
        bearer.set_sensitive(true);
        Ok(self
            .http
            .request(method, url)
            .header(AUTHORIZATION, bearer)
            .header(OUTBOX_DEPTH_HEADER, (self.outbox_depth)().to_string())
            .header(APP_VERSION_HEADER, self.app_version.as_str())
            .timeout(API_TIMEOUT))
    }

    /// Sends, reads the (capped) body, and turns an error status into [`PortalError::Http`].
    async fn send(&self, request: RequestBuilder) -> Result<(Response, Bytes), PortalError> {
        let mut response = request.send().await.map_err(network)?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network)? {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(PortalError::Network("response too large".into()));
            }
            body.extend_from_slice(&chunk);
        }
        let status = response.status();
        if status.is_redirection() {
            return Err(PortalError::Network(
                "the portal redirected the request (not followed)".into(),
            ));
        }
        if !status.is_success() {
            return Err(http_error(status, response.headers(), &body));
        }
        Ok((response, Bytes::from(body)))
    }
}

#[async_trait]
impl PortalClient for HttpPortalClient {
    async fn intent(&self, item: &OutboxItem) -> Result<IntentOutcome, PortalError> {
        let declare = |v: Variant| VariantDeclaration {
            bytes: item.variant(v).bytes,
            sha256: item.variant(v).sha256.clone(),
        };
        let body = PhotoIntentRequest {
            event_id: item.event_id.clone(),
            client_photo_id: item.client_photo_id.clone(),
            session_id: item.session_id.clone(),
            shot: item.shot,
            captured_at: item.captured_at_iso(),
            width: item.width,
            height: item.height,
            variants: IntentVariants {
                thumb: declare(Variant::Thumb),
                hd: declare(Variant::Hd),
            },
        };
        let request = self
            .authed(Method::POST, self.origin.url("/v1/device/photos"))?
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&body).expect("serializable"));
        let (_, body) = self.send(request).await?;
        Ok(match parse::<PhotoIntentResponse>(&body)? {
            PhotoIntentResponse::Ready { .. } => IntentOutcome::Ready,
            PhotoIntentResponse::Rejected { reason, .. } => IntentOutcome::Rejected { reason },
            PhotoIntentResponse::Pending { uploads, .. } => {
                let targets = [(Variant::Thumb, uploads.thumb), (Variant::Hd, uploads.hd)];
                IntentOutcome::Pending {
                    uploads: targets
                        .into_iter()
                        .filter_map(|(variant, target)| target.map(|t| descriptor(variant, t)))
                        .collect(),
                }
            }
        })
    }

    async fn upload(
        &self,
        upload: &UploadDescriptor,
        body: Bytes,
    ) -> Result<UploadOutcome, PortalError> {
        let bad = |what: &str| PortalError::Network(format!("the portal sent an invalid {what}"));
        let url = Url::parse(&upload.url).map_err(|_| bad("upload URL"))?;
        // Never downgrade: an https portal's uploads go over https.
        let secure_enough =
            url.scheme() == "https" || (url.scheme() == "http" && self.origin.0.scheme() == "http");
        if !secure_enough {
            return Err(bad("upload URL"));
        }
        let method =
            Method::from_bytes(upload.method.as_bytes()).map_err(|_| bad("upload method"))?;
        let mut headers = HeaderMap::new();
        for (name, value) in &upload.headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| bad("upload header"))?;
            let value = HeaderValue::from_str(value).map_err(|_| bad("upload header"))?;
            headers.insert(name, value);
        }
        // A plain request: no bearer, no device headers (DESIGN §9.4).
        let request = self
            .http
            .request(method, url)
            .headers(headers)
            .body(body)
            .timeout(UPLOAD_TIMEOUT);
        let (response, body) = self.send(request).await?;
        // The status and the body must agree: a 200 that isn't the portal's answer (a captive
        // portal's page) must not count as stored.
        match (response.status().as_u16(), parse::<UploadResponse>(&body)?) {
            (200, UploadResponse::Stored { .. }) => Ok(UploadOutcome::Stored),
            (201, UploadResponse::Ready { .. }) => Ok(UploadOutcome::Ready),
            (202, UploadResponse::Processing { .. }) => Ok(UploadOutcome::Processing {
                retry_after: retry_after(response.headers()),
            }),
            _ => Err(unexpected()),
        }
    }
}

fn descriptor(variant: Variant, target: UploadTarget) -> UploadDescriptor {
    UploadDescriptor {
        variant,
        method: target.method,
        url: target.url,
        headers: target.headers,
        expires_at: target.expires_at,
    }
}

fn parse<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, PortalError> {
    serde_json::from_slice(body).map_err(|_| unexpected())
}

/// A 2xx we can't read: most likely not the portal at all (a captive portal's login page), so
/// it is retried like a network failure.
fn unexpected() -> PortalError {
    PortalError::Network("unexpected response from the portal".into())
}

fn http_error(status: StatusCode, headers: &HeaderMap, body: &[u8]) -> PortalError {
    let code = serde_json::from_slice::<ErrorBody>(body)
        .ok()
        .and_then(|b| serde_json::from_value::<ErrorCode>(serde_json::Value::String(b.code)).ok());
    PortalError::Http {
        status: status.as_u16(),
        code,
        retry_after: retry_after(headers),
    }
}

/// `Retry-After` in seconds (the portal never sends the HTTP-date form).
fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    value.trim().parse().ok().map(Duration::from_secs)
}

fn network(error: reqwest::Error) -> PortalError {
    PortalError::Network(describe(&error))
}

/// What went wrong, without the URL (an upload URL carries its signature).
fn describe(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "could not connect"
    } else {
        "request failed"
    };
    let mut causes = Vec::new();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        causes.push(cause.to_string());
        source = cause.source();
    }
    match causes.last() {
        Some(root) => format!("{kind}: {root}"),
        None => kind.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use photobooth_core::outbox::{ItemState, VariantInfo};
    use serde_json::Value;

    use super::super::test_server::{Canned, MockPortal, Recorded};
    use super::super::types::tests::fixture;
    use super::*;

    const SECRET: &str = "c2VjcmV0LWNyZWRlbnRpYWwtZm9yLXRlc3RzLTAwMDA";

    fn client(portal: &MockPortal) -> HttpPortalClient {
        HttpPortalClient::new(
            http_client().unwrap(),
            PortalOrigin::parse(&portal.base, false).unwrap(),
            Some(DeviceCredential::new(SECRET)),
            "0.4.0",
            Arc::new(|| 7),
        )
    }

    fn unauthenticated(portal: &MockPortal) -> HttpPortalClient {
        HttpPortalClient::new(
            http_client().unwrap(),
            PortalOrigin::parse(&portal.base, false).unwrap(),
            None,
            "0.4.0",
            Arc::new(|| 0),
        )
    }

    /// The item behind `device.intent-request.valid.json`.
    fn item() -> OutboxItem {
        OutboxItem {
            client_photo_id: "5f0c2b1e-8d3a-4c6f-9b2e-7a1d4e6f8c90".into(),
            event_id: "019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01".into(),
            session_id: "6a3f1c20-3".into(),
            shot: 2,
            captured_at: UNIX_EPOCH + Duration::from_millis(1_792_661_412_345),
            width: 2560,
            height: 1707,
            thumb: VariantInfo {
                bytes: 21873,
                sha256: "f8c433f29893f048dc2505a5dc8b39fe57bf0b4a66a0374476a142c58b640646".into(),
            },
            hd: VariantInfo {
                bytes: 416204,
                sha256: "2c71895fa8203ccefdb64c5c05f6c6d7b9394913c2ac32004c4717a984d151e8".into(),
            },
            state: ItemState::Uploading,
            attempts: 0,
            hash_mismatches: 0,
            next_attempt_at: SystemTime::now(),
            last_error: None,
        }
    }

    /// Rewrites the fixture's example host to the mock server, so its upload URLs come back here.
    fn local(fixture_text: &str, portal: &MockPortal) -> String {
        fixture_text.replace("https://photos.example.invalid", &portal.base)
    }

    fn assert_device_headers(request: &Recorded) {
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {SECRET}").as_str())
        );
        assert_eq!(request.header(OUTBOX_DEPTH_HEADER), Some("7"));
        assert_eq!(request.header(APP_VERSION_HEADER), Some("0.4.0"));
    }

    fn assert_no_device_headers(request: &Recorded) {
        for name in ["authorization", OUTBOX_DEPTH_HEADER, APP_VERSION_HEADER] {
            assert_eq!(
                request.header(name),
                None,
                "{} must not carry {name}",
                request.target
            );
        }
    }

    #[test]
    fn portal_addresses_are_checked() {
        let ok = |s: &str, lan: bool| PortalOrigin::parse(s, lan).map(|o| o.as_str().to_owned());
        assert_eq!(
            ok("https://photos.example.invalid", false).unwrap(),
            "https://photos.example.invalid"
        );
        assert_eq!(
            ok(" https://Photos.Example.invalid/ ", false).unwrap(),
            "https://photos.example.invalid"
        );
        assert_eq!(
            ok("http://photos.localhost:8787", false).unwrap(),
            "http://photos.localhost:8787"
        );
        assert!(ok("http://127.0.0.1:8787", false).is_ok());
        // LAN http only when allowed (debug builds), and never for a public address.
        assert!(ok("http://192.168.1.20:8787", false).is_err());
        assert!(ok("http://192.168.1.20:8787", true).is_ok());
        assert!(ok("http://photos.example.invalid", true).is_err());
        assert!(ok("http://8.8.8.8", true).is_err());
        for bad in [
            "photos.example.invalid",
            "ftp://photos.example.invalid",
            "https://user:pw@photos.example.invalid",
            "https://photos.example.invalid/v1",
            "https://photos.example.invalid/?x=1",
            "https://photos.example.invalid/#k",
            "",
        ] {
            assert!(ok(bad, true).is_err(), "{bad} should be refused");
        }
        let origin = PortalOrigin::parse("http://photos.localhost:8787", false).unwrap();
        assert_eq!(origin.host(), "photos.localhost:8787");
    }

    #[tokio::test]
    async fn enrolment_sends_the_contract_body_without_a_bearer() {
        let portal =
            MockPortal::start(|_| Canned::fixture("device.enrol-response.valid.json")).await;
        let enrolled = unauthenticated(&portal)
            .enrol("7K3M9Q2Z", "Booth 1")
            .await
            .unwrap();
        assert_eq!(enrolled.device_id, "019a0b60-1a2b-7c3d-8e4f-5a6b7c8d9e0f");
        assert_eq!(enrolled.name, "Booth 1");

        let requests = portal.requests();
        let request = &requests[0];
        assert_eq!(
            (request.method.as_str(), request.target.as_str()),
            ("POST", "/v1/device/enrol")
        );
        assert_eq!(request.header("content-type"), Some("application/json"));
        let expected: Value =
            serde_json::from_str(fixture("device.enrol-request.valid.json")).unwrap();
        assert_eq!(request.json(), expected);
        assert_no_device_headers(request);
    }

    #[tokio::test]
    async fn a_refused_enrolment_code_is_a_401_with_its_code() {
        let portal = MockPortal::start(|_| Canned::fixture("error.body.unauthorized.json")).await;
        let err = unauthenticated(&portal)
            .enrol("WRONG", "Booth 1")
            .await
            .unwrap_err();
        assert_eq!(err, PortalError::code(ErrorCode::Unauthorized));
    }

    #[tokio::test]
    async fn rate_limiting_carries_retry_after() {
        let portal = MockPortal::start(|_| {
            Canned::fixture("error.body.rate_limited.json").with_header("Retry-After", "60")
        })
        .await;
        let err = unauthenticated(&portal)
            .enrol("X", "Booth 1")
            .await
            .unwrap_err();
        assert_eq!(
            err,
            PortalError::Http {
                status: 429,
                code: Some(ErrorCode::RateLimited),
                retry_after: Some(Duration::from_secs(60)),
            }
        );
    }

    #[tokio::test]
    async fn events_and_event_detail_send_the_bearer_and_device_headers() {
        let portal = MockPortal::start(|r| match r.target.as_str() {
            "/v1/device/events" => Canned::fixture("device.events-response.valid.json"),
            _ => Canned::fixture("device.event-detail.live.json"),
        })
        .await;
        let client = client(&portal);
        let events = client.events().await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].name, "Ng 40th");
        let detail = client
            .event("019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01")
            .await
            .unwrap();
        assert!(detail.accepts_uploads());

        let requests = portal.requests();
        assert_eq!(requests[0].method, "GET");
        assert_eq!(
            requests[1].target,
            "/v1/device/events/019a0b6c-4f00-7a3e-9c41-5b2d8e0f1a01"
        );
        for request in &requests {
            assert_device_headers(request);
        }
    }

    #[tokio::test]
    async fn a_malformed_event_id_never_reaches_the_network() {
        let portal = MockPortal::start(|_| Canned::json(200, "{}")).await;
        let client = client(&portal);
        for id in ["../enrol", "019A0B6C-4F00-7A3E-9C41-5B2D8E0F1A01", "x", ""] {
            let err = client.event(id).await.unwrap_err();
            assert_eq!(err, PortalError::code(ErrorCode::NotFound), "{id}");
        }
        assert!(portal.requests().is_empty());
    }

    #[tokio::test]
    async fn the_bearer_is_refused_for_another_origin_and_missing_when_not_enrolled() {
        let portal = MockPortal::start(|_| Canned::json(200, "{}")).await;
        let client = client(&portal);
        let foreign = Url::parse("https://elsewhere.example.invalid/v1/device/events").unwrap();
        assert!(matches!(
            client.authed(Method::GET, foreign),
            Err(PortalError::Network(m)) if m.contains("another origin")
        ));
        // Same host, other port: another origin.
        let mut other_port = Url::parse(&portal.base).unwrap();
        let port = other_port.port().unwrap();
        other_port.set_port(Some(port.wrapping_add(1))).unwrap();
        assert!(client.authed(Method::GET, other_port).is_err());

        let err = unauthenticated(&portal).events().await.unwrap_err();
        assert_eq!(err, PortalError::code(ErrorCode::Unauthorized));
        assert!(portal.requests().is_empty());
    }

    #[tokio::test]
    async fn a_revoked_credential_is_a_401() {
        let portal = MockPortal::start(|_| Canned::fixture("error.body.unauthorized.json")).await;
        let err = client(&portal).events().await.unwrap_err();
        assert_eq!(err, PortalError::code(ErrorCode::Unauthorized));
    }

    #[tokio::test]
    async fn the_intent_body_is_the_contract_fixture() {
        let portal =
            MockPortal::start(|_| Canned::fixture("device.intent-response.ready.json")).await;
        let outcome = client(&portal).intent(&item()).await.unwrap();
        assert_eq!(outcome, IntentOutcome::Ready);
        let requests = portal.requests();
        let request = &requests[0];
        assert_eq!(
            (request.method.as_str(), request.target.as_str()),
            ("POST", "/v1/device/photos")
        );
        let expected: Value =
            serde_json::from_str(fixture("device.intent-request.valid.json")).unwrap();
        assert_eq!(request.json(), expected);
        assert_device_headers(request);
    }

    #[tokio::test]
    async fn a_pending_intent_lists_only_the_variants_still_needed() {
        for (name, expected) in [
            (
                "device.intent-response.pending-both.json",
                vec![Variant::Thumb, Variant::Hd],
            ),
            ("device.intent-response.pending-hd.json", vec![Variant::Hd]),
        ] {
            let portal = MockPortal::start(move |_| Canned::fixture(name)).await;
            let IntentOutcome::Pending { uploads } = client(&portal).intent(&item()).await.unwrap()
            else {
                panic!("{name}: pending");
            };
            let variants: Vec<Variant> = uploads.iter().map(|u| u.variant).collect();
            assert_eq!(variants, expected, "{name}");
            let hd = uploads.last().unwrap();
            assert_eq!(hd.method, "PUT");
            assert!(hd
                .url
                .ends_with("/hd?exp=1792578600&sig=ZXhhbXBsZS1zaWduYXR1cmUtbm90LXJlYWwtMDAwMDA"));
            assert_eq!(hd.headers["Content-Type"], "image/jpeg");
            assert_eq!(hd.expires_at, "2026-10-22T09:45:00.000Z");
        }
    }

    #[tokio::test]
    async fn a_rejected_intent_carries_the_reason() {
        let portal =
            MockPortal::start(|_| Canned::fixture("device.intent-response.rejected.json")).await;
        let outcome = client(&portal).intent(&item()).await.unwrap();
        assert_eq!(
            outcome,
            IntentOutcome::Rejected {
                reason: "segment 0xe1 not allowed".into()
            }
        );
    }

    #[tokio::test]
    async fn intent_errors_map_to_their_codes() {
        for (file, code) in [
            ("device.intent-response.conflict.json", ErrorCode::Conflict),
            ("error.body.event_closed.json", ErrorCode::EventClosed),
            ("error.body.photo_limit.json", ErrorCode::PhotoLimit),
            ("error.body.too_large.json", ErrorCode::TooLarge),
            ("error.body.internal.json", ErrorCode::Internal),
        ] {
            let portal = MockPortal::start(move |_| Canned::fixture(file)).await;
            let err = client(&portal).intent(&item()).await.unwrap_err();
            assert_eq!(err, PortalError::code(code), "{file}");
        }
    }

    #[tokio::test]
    async fn a_proxy_error_page_is_a_bare_status_and_a_login_page_is_retried() {
        let portal = MockPortal::start(|r| match r.target.as_str() {
            "/v1/device/photos" => Canned {
                status: 502,
                headers: vec![("Content-Type".into(), "text/html".into())],
                body: b"<html>bad gateway</html>".to_vec(),
            },
            _ => Canned {
                status: 200,
                headers: vec![("Content-Type".into(), "text/html".into())],
                body: b"<html>Sign in to the venue Wi-Fi</html>".to_vec(),
            },
        })
        .await;
        let client = client(&portal);
        assert_eq!(
            client.intent(&item()).await.unwrap_err(),
            PortalError::Http {
                status: 502,
                code: None,
                retry_after: None
            }
        );
        assert!(matches!(
            client.events().await,
            Err(PortalError::Network(_))
        ));
    }

    /// Not followed, and retried like any answer that isn't the portal's (a captive portal on
    /// plain http redirects to its login page), not parked as needing attention.
    #[tokio::test]
    async fn redirects_are_not_followed() {
        let portal = MockPortal::start(|r| match r.target.as_str() {
            "/v1/device/events" => Canned::json(302, "{}").with_header("Location", "/elsewhere"),
            _ => Canned::fixture("device.events-response.valid.json"),
        })
        .await;
        let err = client(&portal).events().await.unwrap_err();
        assert!(
            matches!(&err, PortalError::Network(m) if m.contains("redirect")),
            "{err:?}"
        );
        assert_eq!(portal.requests().len(), 1);
    }

    fn put_descriptor(portal: &MockPortal, variant: Variant) -> UploadDescriptor {
        let pending = local(fixture("device.intent-response.pending-both.json"), portal);
        let PhotoIntentResponse::Pending { uploads, .. } = serde_json::from_str(&pending).unwrap()
        else {
            unreachable!()
        };
        let target = match variant {
            Variant::Thumb => uploads.thumb.unwrap(),
            Variant::Hd => uploads.hd.unwrap(),
        };
        descriptor(variant, target)
    }

    #[tokio::test]
    async fn an_upload_sends_exactly_the_given_headers_and_no_bearer() {
        let portal =
            MockPortal::start(|_| Canned::fixture("device.upload-response.stored.json")).await;
        let mut upload = put_descriptor(&portal, Variant::Thumb);
        upload
            .headers
            .insert("x-amz-checksum-sha256".into(), "abc=".into());
        let body = Bytes::from_static(b"\xFF\xD8jpeg\xFF\xD9");
        let outcome = client(&portal).upload(&upload, body.clone()).await.unwrap();
        assert_eq!(outcome, UploadOutcome::Stored);

        let requests = portal.requests();
        let request = &requests[0];
        assert_eq!(request.method, "PUT");
        assert!(request
            .target
            .starts_with("/v1/device/uploads/019a0b7e-8c21-7d05-a3f6-0e1f2a3b4c5d/thumb?exp="));
        assert_eq!(request.body, body.to_vec());
        assert_eq!(request.header("content-type"), Some("image/jpeg"));
        assert_eq!(request.header("x-amz-checksum-sha256"), Some("abc="));
        assert_eq!(
            request.header("content-length"),
            Some(body.len().to_string().as_str())
        );
        assert_no_device_headers(request);
        // Nothing else beyond what HTTP itself needs.
        let allowed = [
            "content-type",
            "x-amz-checksum-sha256",
            "content-length",
            "host",
            "accept",
            "user-agent",
        ];
        for (name, _) in &request.headers {
            assert!(allowed.contains(&name.as_str()), "unexpected header {name}");
        }
    }

    #[tokio::test]
    async fn upload_statuses_map_to_outcomes() {
        for (file, expected) in [
            ("device.upload-response.stored.json", UploadOutcome::Stored),
            ("device.upload-response.ready.json", UploadOutcome::Ready),
            (
                "device.upload-response.processing.json",
                UploadOutcome::Processing {
                    retry_after: Some(Duration::from_secs(5)),
                },
            ),
        ] {
            let portal =
                MockPortal::start(move |_| Canned::fixture(file).with_header("Retry-After", "5"))
                    .await;
            let upload = put_descriptor(&portal, Variant::Hd);
            let outcome = client(&portal)
                .upload(&upload, Bytes::from_static(b"x"))
                .await
                .unwrap();
            assert_eq!(outcome, expected, "{file}");
        }
    }

    /// A 200 that isn't the portal's answer (a captive portal's page), or a status that
    /// disagrees with the body, is retried, never counted as stored.
    #[tokio::test]
    async fn an_upload_answer_must_be_the_portals() {
        for (status, body) in [
            (200, "<html>Sign in to the venue Wi-Fi</html>"),
            (200, fixture("device.upload-response.ready.json")),
            (201, fixture("device.upload-response.stored.json")),
        ] {
            let portal = MockPortal::start(move |_| Canned::json(status, body)).await;
            let upload = put_descriptor(&portal, Variant::Hd);
            let err = client(&portal)
                .upload(&upload, Bytes::from_static(b"x"))
                .await
                .unwrap_err();
            assert!(matches!(err, PortalError::Network(_)), "{status} {body}");
        }
    }

    #[tokio::test]
    async fn upload_errors_map_to_their_codes() {
        for (file, code) in [
            ("error.body.upload_expired.json", ErrorCode::UploadExpired),
            ("error.body.hash_mismatch.json", ErrorCode::HashMismatch),
            ("error.body.invalid_image.json", ErrorCode::InvalidImage),
            ("error.body.forbidden.json", ErrorCode::Forbidden),
        ] {
            let portal = MockPortal::start(move |_| Canned::fixture(file)).await;
            let upload = put_descriptor(&portal, Variant::Hd);
            let err = client(&portal)
                .upload(&upload, Bytes::from_static(b"x"))
                .await
                .unwrap_err();
            assert_eq!(err, PortalError::code(code), "{file}");
        }
    }

    #[tokio::test]
    async fn an_https_portal_never_uploads_over_plain_http() {
        let client = HttpPortalClient::new(
            http_client().unwrap(),
            PortalOrigin::parse("https://photos.example.invalid", false).unwrap(),
            Some(DeviceCredential::new(SECRET)),
            "0.4.0",
            Arc::new(|| 0),
        );
        let mut upload = put_descriptor(
            &MockPortal::start(|_| Canned::json(200, "{}")).await,
            Variant::Hd,
        );
        upload.url = "http://photos.example.invalid/v1/device/uploads/x/hd".into();
        let err = client.upload(&upload, Bytes::new()).await.unwrap_err();
        assert!(matches!(err, PortalError::Network(m) if m.contains("upload URL")));
    }

    #[tokio::test]
    async fn network_errors_do_not_quote_the_signed_url() {
        // Nothing listens on port 9 (discard) on loopback in CI or on the PC.
        let portal = MockPortal::start(|_| Canned::json(200, "{}")).await;
        let mut upload = put_descriptor(&portal, Variant::Hd);
        upload.url = "http://127.0.0.1:9/v1/device/uploads/x/hd?exp=1&sig=SIGNATURE".into();
        let err = client(&portal)
            .upload(&upload, Bytes::from_static(b"x"))
            .await
            .unwrap_err();
        let PortalError::Network(message) = err else {
            panic!("network error expected, got {err:?}");
        };
        assert!(!message.contains("SIGNATURE"), "{message}");
        assert!(!message.contains("127.0.0.1:9"), "{message}");
    }

    #[test]
    fn the_tls_client_builds() {
        http_client().unwrap();
    }
}
