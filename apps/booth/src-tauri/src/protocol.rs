//! The `booth://` custom protocol: serves captured JPEGs from the in-memory `PhotoStore`.
//!
//! The WebView sees different URL shapes per platform, so parsing accepts all of them:
//!
//! | Platform | URL |
//! |----------|-----|
//! | macOS / Linux | `booth://localhost/photo/<session>/<shot>` or `booth://photo/<session>/<shot>` |
//! | Windows / Android | `http://booth.localhost/photo/<session>/<shot>` (also `https`) |

use std::borrow::Cow;

use photobooth_core::PhotoStore;
use tauri::http::{header, Response, StatusCode};

/// Extracts `(session_id, shot)` from any of the URL shapes above.
pub fn parse_photo_url(uri: &str) -> Option<(String, u8)> {
    let (scheme, rest) = uri.split_once("://")?;
    let rest = rest.split(['?', '#']).next()?;
    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, p),
        None => (rest, ""),
    };

    let mut segments: Vec<&str> = Vec::new();
    match (scheme, authority) {
        ("booth", "photo") => segments.push("photo"),
        ("booth", "localhost") | ("http" | "https", "booth.localhost") => {}
        _ => return None,
    }
    segments.extend(path.split('/').filter(|s| !s.is_empty()));

    match segments.as_slice() {
        ["photo", session, shot] if !session.is_empty() => {
            Some(((*session).to_owned(), shot.parse().ok()?))
        }
        _ => None,
    }
}

/// Builds the protocol response. Never caches: session ids are unique per run, but a stale
/// cached photo of a cleared session must not be shown either.
///
/// Cross-origin reads are allowed (`*`): the page runs on `tauri.localhost` and the photos on
/// `booth.localhost`, and a canvas that has drawn a photo from another origin without this is
/// tainted and cannot be exported. The scheme is only reachable from this app's own WebView,
/// and the photos are the same ones it already displays.
pub fn respond(photos: &PhotoStore, uri: &str) -> Response<Cow<'static, [u8]>> {
    let photo = parse_photo_url(uri).and_then(|(session, shot)| photos.get(&session, shot));
    match photo {
        Some(jpeg) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Owned(jpeg.to_vec())),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Borrowed(&b""[..])),
    }
    .expect("static headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    #[test]
    fn parses_every_platform_url_shape() {
        let want = Some(("abc-1".to_owned(), 2));
        for uri in [
            "booth://localhost/photo/abc-1/2",
            "booth://photo/abc-1/2",
            "booth://photo/abc-1/2?cache=1",
            "booth://photo/abc-1/2#frag",
            "http://booth.localhost/photo/abc-1/2",
            "https://booth.localhost/photo/abc-1/2",
            "http://booth.localhost/photo/abc-1/2/",
        ] {
            assert_eq!(parse_photo_url(uri), want, "{uri}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for uri in [
            "",
            "booth://localhost/photo/abc-1",
            "booth://localhost/photo/abc-1/x",
            "booth://localhost/photo/abc-1/300", // not a u8
            "booth://localhost/photo//2",
            "booth://localhost/other/abc-1/2",
            "booth://evil/photo/abc-1/2",
            "http://example.com/photo/abc-1/2",
            "ftp://booth.localhost/photo/abc-1/2",
            "booth://localhost/photo/a/b/2",
            "booth://localhost/photo/abc-1/2/extra",
            "no scheme at all",
        ] {
            assert_eq!(parse_photo_url(uri), None, "{uri}");
        }
    }

    #[test]
    fn serves_a_stored_photo_as_uncached_jpeg() {
        let photos = PhotoStore::new();
        photos.put("s1", 1, Bytes::from_static(&[0xFF, 0xD8, 0xFF, 0xD9]));
        let response = respond(&photos, "http://booth.localhost/photo/s1/1");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.body().as_ref(), &[0xFF, 0xD8, 0xFF, 0xD9]);
    }

    /// The page and the photos are different origins (`tauri.localhost` vs `booth.localhost`).
    /// Without this header a canvas that has drawn a photo is "tainted" and cannot be exported,
    /// which is what the strip needs to keep a small, ready-decoded copy of each photo.
    #[test]
    fn photos_may_be_read_by_the_app_page_so_a_canvas_can_use_them() {
        let photos = PhotoStore::new();
        photos.put("s1", 1, Bytes::from_static(&[0xFF, 0xD8, 0xFF, 0xD9]));
        for uri in [
            "http://booth.localhost/photo/s1/1",
            "booth://localhost/photo/s1/1",
            "http://booth.localhost/photo/s1/9", // 404s too, so the page sees a plain failure
        ] {
            let response = respond(&photos, uri);
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                "*",
                "{uri}"
            );
        }
    }

    /// The strip fetches each photo to prepare a small copy of it (fetch is governed by
    /// `connect-src`, images by `img-src`). Pin both, and that nothing else was loosened.
    #[test]
    fn the_csp_lets_the_page_fetch_its_own_photos_and_stays_strict() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("a CSP is set");
        let directive = |name: &str| -> Vec<&str> {
            csp.split(';')
                .map(str::trim)
                .find_map(|d| d.strip_prefix(name))
                .map(|rest| rest.split_whitespace().collect())
                .unwrap_or_default()
        };
        let connect = directive("connect-src");
        for source in [
            "ipc:",
            "http://ipc.localhost",
            "http://booth.localhost",
            "booth:",
        ] {
            assert!(
                connect.contains(&source),
                "connect-src must allow {source}: {csp}"
            );
        }
        assert!(
            directive("img-src").contains(&"blob:"),
            "the small copies are blob: images"
        );
        assert_eq!(directive("default-src"), vec!["'self'"]);
        assert!(
            !csp.contains("unsafe-eval") && !csp.contains("unsafe-inline"),
            "{csp}"
        );
        assert!(
            !connect.contains(&"*") && !connect.contains(&"http:") && !connect.contains(&"https:")
        );
    }

    #[test]
    fn missing_photos_are_404_including_after_the_session_clears() {
        let photos = PhotoStore::new();
        photos.put("s1", 1, Bytes::from_static(b"x"));
        assert_eq!(
            respond(&photos, "booth://localhost/photo/s1/9").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(&photos, "booth://localhost/photo/nope/1").status(),
            StatusCode::NOT_FOUND
        );
        photos.clear();
        let response = respond(&photos, "booth://localhost/photo/s1/1");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.body().is_empty());
        assert_eq!(respond(&photos, "garbage").status(), StatusCode::NOT_FOUND);
    }
}
