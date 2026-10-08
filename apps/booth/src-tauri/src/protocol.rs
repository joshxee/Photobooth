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
pub fn respond(photos: &PhotoStore, uri: &str) -> Response<Cow<'static, [u8]>> {
    let photo = parse_photo_url(uri).and_then(|(session, shot)| photos.get(&session, shot));
    match photo {
        Some(jpeg) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Cow::Owned(jpeg.to_vec())),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CACHE_CONTROL, "no-store")
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
