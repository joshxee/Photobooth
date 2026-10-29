//! The post-shoot screen's way to the guest's photos (DESIGN §10 item 4, §11; session 13).
//!
//! The booth keeps the selected event's gallery link in memory only and turns it into a QR
//! code for each session: the link with `s={session_id}&n={shots}` added to its fragment, so
//! the guest's phone opens the gallery on their own shots. The link carries the event's share
//! token, so it never leaves Rust as text: the WebView gets an SVG, and nothing here logs it.

use std::fmt;
use std::sync::{Mutex, MutexGuard};

use qrcode::{Color, EcLevel, QrCode};
use reqwest::Url;
use serde::{Deserialize, Serialize};

use super::client::PortalOrigin;

/// An event's gallery link with its share token (`/e/{id}#k={token}`). Anyone holding it can
/// see the event's photos, so it has no `Display` and a redacted `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GalleryUrl(String);

impl GalleryUrl {
    /// The portal's link, if it is a gallery link (`/e/{publicId}`, as the gallery parses it)
    /// on the enrolled portal's own origin: a QR code on the booth must never send guests
    /// anywhere else.
    pub fn checked(self, origin: &PortalOrigin) -> Option<Self> {
        let url = Url::parse(&self.0).ok()?;
        let id = url.path().strip_prefix("/e/")?;
        let id = id.strip_suffix('/').unwrap_or(id);
        (origin.is_same_origin(&url) && is_link_id(id)).then_some(self)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for GalleryUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GalleryUrl(<redacted>)")
    }
}

/// The gallery's rule for the IDs in its link (`src/web/gallery/link.ts`: the public ID and
/// the session ID, the contract's `SessionId`).
pub(crate) fn is_link_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The QR code's link for one session: the gallery link's fragment becomes
/// `k={token}&s={session_id}&n={shots}`, exactly what the gallery reads, so the session is
/// in it once whatever the portal's fragment held (anything else there is dropped, including
/// an `s` or `n`, however encoded). `None` without a token, or for a session ID or a shot
/// count (1–10) the gallery would ignore.
pub fn session_link(gallery: &GalleryUrl, session_id: &str, shots: usize) -> Option<String> {
    if !is_link_id(session_id) || !(1..=10).contains(&shots) {
        return None;
    }
    let mut url = Url::parse(gallery.expose()).ok()?;
    let token = url
        .fragment()
        .unwrap_or_default()
        .split('&')
        .find(|pair| pair.starts_with("k=") && pair.len() > 2)?
        .to_owned();
    url.set_fragment(Some(&format!("{token}&s={session_id}&n={shots}")));
    Some(url.into())
}

/// Light modules around the code, as the QR standard asks (4). The SVG carries them, so the
/// code scans whatever is around it on screen.
const QUIET_ZONE: usize = 4;

/// `text` as an SVG QR code that scales to its box (a `viewBox`, no size). Error correction
/// `L`: the code is drawn on a screen, so it is never damaged, and the fewer modules the
/// larger each one is at the same size, which matters for a scan from about 1 m.
pub fn qr_svg(text: &str) -> Option<String> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L).ok()?;
    let width = code.width();
    let colors = code.to_colors();
    let size = width + 2 * QUIET_ZONE;
    let mut path = String::new();
    for (y, row) in colors.chunks(width).enumerate() {
        let mut x = 0;
        while x < width {
            if row[x] != Color::Dark {
                x += 1;
                continue;
            }
            let start = x;
            while x < width && row[x] == Color::Dark {
                x += 1;
            }
            // One rectangle per horizontal run of dark modules.
            let run = x - start;
            path.push_str(&format!(
                "M{} {}h{run}v1h-{run}z",
                start + QUIET_ZONE,
                y + QUIET_ZONE
            ));
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" \
         shape-rendering=\"crispEdges\" aria-hidden=\"true\">\
         <rect width=\"{size}\" height=\"{size}\" fill=\"#fff\"/>\
         <path fill=\"#000\" d=\"{path}\"/></svg>"
    ))
}

/// What the post-shoot screen offers the guest, for the WebView.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SessionShare {
    /// The session's QR code: the gallery is LIVE and its link is known.
    Qr { svg: String },
    /// The shots are on their way to the event, but there is no link to show: the gallery
    /// isn't LIVE, or the booth hasn't heard from the portal yet.
    EventGallery,
    /// The shots don't go to a portal (not enrolled, no event, the test camera): the screen
    /// is as it was before the portal.
    None,
}

impl SessionShare {
    /// The mode alone, for the log: never the SVG.
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Qr { .. } => "qr",
            Self::EventGallery => "event_gallery",
            Self::None => "none",
        }
    }
}

/// The session last handed to the outbox.
#[derive(Clone, Debug, PartialEq, Eq)]
struct HandedOver {
    session_id: String,
    event_id: String,
    shots: usize,
}

/// The selected event's gallery link, as the portal last gave it. `None` while it isn't LIVE.
#[derive(Clone, Debug)]
struct KnownGallery {
    event_id: String,
    url: Option<GalleryUrl>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Memory only: the gallery link and the last session handed over. A restart forgets both,
/// and the booth asks the portal again.
#[derive(Default)]
pub struct PostShoot {
    gallery: Mutex<Option<KnownGallery>>,
    last: Mutex<Option<HandedOver>>,
}

impl PostShoot {
    /// Records what the portal says about `event_id`'s gallery: its link while LIVE, else
    /// `None`.
    pub fn set_gallery(&self, event_id: &str, url: Option<GalleryUrl>) {
        *lock(&self.gallery) = Some(KnownGallery {
            event_id: event_id.to_owned(),
            url,
        });
    }

    /// [`PostShoot::set_gallery`], but only if `still_selected()` holds, checked under the same
    /// lock as the write: a refresh that raced an event change can't overwrite the new event's
    /// link (the selection writes the settings before the link). Returns whether it wrote.
    pub fn set_gallery_if(
        &self,
        event_id: &str,
        url: Option<GalleryUrl>,
        still_selected: impl FnOnce() -> bool,
    ) -> bool {
        let mut gallery = lock(&self.gallery);
        if !still_selected() {
            return false;
        }
        *gallery = Some(KnownGallery {
            event_id: event_id.to_owned(),
            url,
        });
        true
    }

    /// Forgets the link (unenrolled, event cleared, revoked).
    pub fn forget_gallery(&self) {
        *lock(&self.gallery) = None;
    }

    /// The link for `event_id`, if it is the one known and its gallery is LIVE.
    pub fn gallery_for(&self, event_id: &str) -> Option<GalleryUrl> {
        lock(&self.gallery)
            .as_ref()
            .filter(|known| known.event_id == event_id)
            .and_then(|known| known.url.clone())
    }

    /// The outbox took `session_id` for `event_id`. Returns whether its review will show a
    /// QR code, so the session can keep the review up for longer.
    pub fn handed_over(&self, session_id: &str, event_id: &str, shots: usize) -> bool {
        *lock(&self.last) = Some(HandedOver {
            session_id: session_id.to_owned(),
            event_id: event_id.to_owned(),
            shots,
        });
        self.gallery_for(event_id)
            .and_then(|url| session_link(&url, session_id, shots))
            .is_some()
    }

    /// What the review of `session_id` shows.
    pub fn share(&self, session_id: &str) -> SessionShare {
        let Some(last) = lock(&self.last)
            .clone()
            .filter(|last| last.session_id == session_id)
        else {
            return SessionShare::None;
        };
        let svg = self
            .gallery_for(&last.event_id)
            .and_then(|url| session_link(&url, &last.session_id, last.shots))
            .and_then(|link| qr_svg(&link));
        match svg {
            Some(svg) => SessionShare::Qr { svg },
            None => SessionShare::EventGallery,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const LIVE: &str = "https://photos.example.invalid/e/k7m2q9x4c3v8b6n5#k=ZXhhbXBsZS10b2tlbi0wMQ";

    fn url(raw: &str) -> GalleryUrl {
        GalleryUrl(raw.to_owned())
    }

    fn origin() -> PortalOrigin {
        PortalOrigin::parse("https://photos.example.invalid", false).unwrap()
    }

    #[test]
    fn the_session_and_shot_count_join_the_token_in_the_fragment() {
        assert_eq!(
            session_link(&url(LIVE), "6a3f1c20-3", 3).as_deref(),
            Some(
                "https://photos.example.invalid/e/k7m2q9x4c3v8b6n5\
                 #k=ZXhhbXBsZS10b2tlbi0wMQ&s=6a3f1c20-3&n=3"
            )
        );
    }

    #[test]
    fn fragment_edge_cases_still_give_one_well_formed_fragment() {
        let base = "https://photos.example.invalid/e/abc";
        for (gallery, expected) in [
            (
                format!("{base}#k=t&"),
                Some(format!("{base}#k=t&s=s-1&n=2")),
            ),
            (
                format!("{base}#&&k=t"),
                Some(format!("{base}#k=t&s=s-1&n=2")),
            ),
            (
                format!("{base}#k=t&k=u"),
                Some(format!("{base}#k=t&s=s-1&n=2")),
            ),
            // No token: the gallery couldn't open it, so no QR code.
            (base.to_owned(), None),
            (format!("{base}#"), None),
            (format!("{base}#k="), None),
        ] {
            assert_eq!(
                session_link(&url(&gallery), "s-1", 2),
                expected,
                "from {gallery}"
            );
        }
    }

    #[test]
    fn the_session_is_appended_once_even_if_the_link_already_has_one() {
        // `%73` is an encoded `s`: URLSearchParams would decode it and read the first `s`.
        let link = session_link(
            &url(&format!("{LIVE}&s=old-1&n=9&ss=x&%73=evil-1")),
            "new-2",
            4,
        )
        .unwrap();
        let fragment = link.split_once('#').unwrap().1;
        assert_eq!(fragment, "k=ZXhhbXBsZS10b2tlbi0wMQ&s=new-2&n=4");
    }

    #[test]
    fn a_session_or_count_the_gallery_would_ignore_gives_no_link() {
        let long = "x".repeat(65);
        for (session, shots) in [
            ("", 3),
            ("a b", 3),
            ("a&k=evil", 3),
            (long.as_str(), 3),
            ("ok-1", 0),
            ("ok-1", 11),
        ] {
            assert_eq!(
                session_link(&url(LIVE), session, shots),
                None,
                "{session:?} {shots}"
            );
        }
        assert!(session_link(&url(LIVE), &"x".repeat(64), 10).is_some());
    }

    #[test]
    fn only_a_gallery_link_on_the_enrolled_origin_is_kept() {
        assert!(url(LIVE).checked(&origin()).is_some());
        assert!(
            url("https://photos.example.invalid/e/k7m2q9x4c3v8b6n5/#k=t")
                .checked(&origin())
                .is_some()
        );
        for other in [
            "https://evil.example/e/k7m2q9x4c3v8b6n5#k=t",
            "http://photos.example.invalid/e/k7m2q9x4c3v8b6n5#k=t",
            "https://photos.example.invalid:8443/e/k7m2q9x4c3v8b6n5#k=t",
            "https://photos.example.invalid/admin#k=t",
            "https://photos.example.invalid/e/a/b#k=t",
            "https://photos.example.invalid/e/#k=t",
            "https://photos.example.invalid/e/a%20b#k=t",
            "not a url",
        ] {
            assert!(url(other).checked(&origin()).is_none(), "{other}");
        }
    }

    #[test]
    fn the_link_never_shows_in_debug_output() {
        let known = KnownGallery {
            event_id: "e".into(),
            url: Some(url(LIVE)),
        };
        let printed = format!("{known:?} {:?}", url(LIVE));
        assert!(!printed.contains("ZXhhbXBsZS10b2tlbi0wMQ"), "{printed}");
    }

    /// Draws the SVG's rectangles as pixels and reads them back with an independent decoder.
    pub(crate) fn decode(svg: &str) -> String {
        let size: usize = svg
            .split("viewBox=\"0 0 ")
            .nth(1)
            .and_then(|rest| rest.split(' ').next())
            .unwrap()
            .parse()
            .unwrap();
        let d = svg
            .split(" d=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let mut dark = vec![false; size * size];
        for rect in d.split('M').filter(|r| !r.is_empty()) {
            // "{x} {y}h{run}v1h-{run}z"
            let (xy, rest) = rect.split_once('h').unwrap();
            let (x, y) = xy.split_once(' ').unwrap();
            let (x, y): (usize, usize) = (x.parse().unwrap(), y.parse().unwrap());
            let run: usize = rest.split('v').next().unwrap().parse().unwrap();
            for col in x..x + run {
                dark[y * size + col] = true;
            }
        }
        const SCALE: usize = 6;
        let px = size * SCALE;
        let mut image = rqrr::PreparedImage::prepare_from_greyscale(px, px, |x, y| {
            if dark[(y / SCALE) * size + x / SCALE] {
                0
            } else {
                255
            }
        });
        let grids = image.detect_grids();
        assert_eq!(grids.len(), 1, "one code");
        grids[0].decode().unwrap().1
    }

    #[test]
    fn the_svg_reads_back_as_the_session_link_and_scales_to_its_box() {
        let link = session_link(&url(LIVE), "6a3f1c20-3", 3).unwrap();
        let svg = qr_svg(&link).unwrap();
        assert_eq!(decode(&svg), link);
        assert!(svg.starts_with("<svg "), "no XML prolog inside the page");
        assert!(svg.contains("viewBox=\"0 0 "));
        assert!(!svg.contains("<svg width"), "no fixed size: CSS sizes it");
        assert!(
            !svg.contains("ZXhhbXBsZS10b2tlbi0wMQ"),
            "never the token as text"
        );
    }

    /// A staging-length link (a 43-character origin, a 43-character token) stays at version 6
    /// (41 modules) with error correction L, so each module is as large as it can be.
    #[test]
    fn a_staging_length_link_stays_a_small_code() {
        let gallery = url(&format!(
            "https://portal-staging.josh-33c.workers.dev/e/{}#k={}",
            "a".repeat(16),
            "b".repeat(43)
        ));
        let link = session_link(&gallery, "6a3f1c20-12", 3).unwrap();
        let svg = qr_svg(&link).unwrap();
        let modules = 41 + 2 * QUIET_ZONE;
        assert!(
            svg.contains(&format!("viewBox=\"0 0 {modules} {modules}\"")),
            "{} characters",
            link.len()
        );
    }

    #[test]
    fn a_handed_over_session_shows_its_qr_only_while_its_gallery_is_live() {
        let post = PostShoot::default();
        assert_eq!(post.share("s-1"), SessionShare::None, "nothing handed over");

        // Handed over before the portal said anything: on its way, no link.
        assert!(!post.handed_over("s-1", "ev", 3));
        assert_eq!(post.share("s-1"), SessionShare::EventGallery);

        // The gallery goes LIVE: the next session gets a QR code (and a longer review).
        post.set_gallery("ev", Some(url(LIVE)));
        assert!(post.handed_over("s-2", "ev", 3));
        let SessionShare::Qr { svg } = post.share("s-2") else {
            panic!("expected a QR code");
        };
        assert_eq!(decode(&svg), session_link(&url(LIVE), "s-2", 3).unwrap());
        assert_eq!(
            post.share("s-1"),
            SessionShare::None,
            "only the last session"
        );

        // Another event's link is never used.
        assert!(!post.handed_over("s-3", "other", 3));
        assert_eq!(post.share("s-3"), SessionShare::EventGallery);

        // Hidden again, or forgotten.
        post.set_gallery("ev", None);
        assert!(!post.handed_over("s-4", "ev", 3));
        assert_eq!(post.share("s-4"), SessionShare::EventGallery);
        post.set_gallery("ev", Some(url(LIVE)));
        post.forget_gallery();
        assert_eq!(post.gallery_for("ev"), None);
    }

    /// A refresh that raced the operator's change of event writes nothing.
    #[test]
    fn a_stale_refresh_never_overwrites_the_new_events_link() {
        let post = PostShoot::default();
        post.set_gallery("new", Some(url(LIVE)));
        assert!(!post.set_gallery_if("old", None, || false));
        assert!(post.gallery_for("new").is_some(), "kept");
        assert!(post.set_gallery_if("new", None, || true));
        assert_eq!(post.gallery_for("new"), None);
    }

    #[test]
    fn the_share_reaches_the_webview_tagged_by_mode() {
        let json = |s: &SessionShare| serde_json::to_value(s).unwrap();
        assert_eq!(
            json(&SessionShare::None),
            serde_json::json!({"mode": "none"})
        );
        assert_eq!(
            json(&SessionShare::EventGallery),
            serde_json::json!({"mode": "event_gallery"})
        );
        assert_eq!(
            json(&SessionShare::Qr {
                svg: "<svg/>".into()
            }),
            serde_json::json!({"mode": "qr", "svg": "<svg/>"})
        );
    }
}
