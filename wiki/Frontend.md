# Frontend (`apps/booth`)

React 19 + TypeScript on a **bun-only** toolchain. The WebView is the least-trusted layer:
it renders state it receives over IPC and sends user intent back. No business logic lives
here — the session state machine, camera orchestration and settings validation are all in
Rust (see [Core-Domain.md](./Core-Domain.md)).

## Why bun-only

One tool for package management (`bun install`), bundling (`Bun.build`), the dev server
(`Bun.serve` with HMR) and tests (`bun test` + happy-dom). That removes Vite, npm and Jest
from the dependency tree and the toolchain a contributor must understand. It was verified
working here: `bun run dev` serves on port 1420 with HMR, `bun run build` emits `dist/`, the
suite runs in ~7 s, and the real Tauri app was driven through it (see "How it was verified").

**Escape hatch:** if bun's dev server or bundler ever becomes unworkable (for example an HMR
bug on a particular Android WebView), switching to Vite is a half-day change that touches no
React code — only `dev.ts`, `build.ts` and `package.json`. **Note the switch** in this file
and in the commit message; do not silently fall back to npm.

## Layout

```
index.html            entry; links src/styles.css, loads src/main.tsx
dev.ts / build.ts     Bun.serve dev server (port 1420, HMR, console streaming) / Bun.build
src/ipc/              typed wrappers for every command, event listeners, live-view painter, photoUrl
src/store/            Zustand store fed only by IPC events (+ bridge.ts that attaches them)
src/screens/          CameraSelect, Booth (+ BoothViews), Settings, DevPanel
src/components/       FillButton, PhotoStrip, ShotPips
src/platform.ts       back button + keep-awake/immersive via the Android plugin (no-op on desktop)
src/fonts/            Geist / Geist Mono, copied from the old Compose resources
```

## IPC conventions

- Commands return `Result<T, string>`; rejections surface as a dismissible **notice** at the
  bottom of the screen rather than being swallowed.
- **Live view** uses a `Channel` carrying **raw JPEG bytes** (one `ArrayBuffer` per frame),
  never base64 through JSON. `createFramePainter` decodes with `createImageBitmap` and has
  *keep-latest* semantics: if a decode is in flight, the newest frame is parked and older
  ones are dropped, so the preview never lags progressively behind the camera.
- **Photos** are plain `<img src>` pointing at the backend's in-memory `booth://` protocol.
  `photoUrl()` picks `http://booth.localhost/photo/<session>/<shot>` on Windows/Android and
  `booth://localhost/...` on macOS/Linux. A photo that fails to load (e.g. a 404 after the
  session cleared) is replaced by a labelled placeholder.
- On startup the bridge attaches the `session://state` / `camera://status` listeners
  *first*, then loads snapshots (`session_state`, `camera_list`, `settings_get`); a snapshot
  never overwrites a newer event. `session_state` is not in the original command list — it
  exists so a WebView that reloads mid-session (HMR in dev) can resynchronise.
- Camera start/stop calls from the Booth screen are **serialised** through a tiny promise
  chain, because a "Retry connection" that disconnects while a connect is mid-way would race.

## Original UI parity

Visible strings were ported verbatim from the old Compose app's Knockbox UI (deleted at the
cutover; see git history) so the Maestro flows could be re-targeted rather than rewritten: "Select Camera", "Continue →", "Welcome to the
booth —\nraise your hand", "or", "Tap to start photoshoot", "Look at the lens", "VIRTUAL PHOTO
STRIP SAVED — COPIES WILL BE AVAILABLE AFTER THE EVENT", "Looking good.", "Take another strip
→", "RETURNING TO PHOTOBOOTH", "Retry connection", and the Settings labels ("Number of
Photos", "Countdown Seconds", "Photo Strip Display Time", "Current Configuration"). Layout,
tokens (paper/ink/forest), type sizes and animations (arrow bounce, numeral pop, 3 s pill
fill) follow the original too.

Deliberate differences:

- The test camera card is **"Test Camera"**, not "Mock Camera (Testing)" (it is a real
  backend now). Sony is **"Sony A7 III (USB)"**; the Wi-Fi card and "Sony API Discovery" are gone.
- **Attract has two layouts.** Tap-only (gestures off, or a native-preview camera that streams no
  frames): "Welcome to the booth" and the large "Tap to start photoshoot" pill (the Maestro
  contract). With **Open-Palm Start** on and a channel camera: "Put your palm in the box to start
  the photobooth", a box floating on the right half (a third of the screen wide, 4:5), a small
  "Tap here to start" pill bottom-left. The box is a **window**: everything outside it is dimmed by
  a huge spread `box-shadow`, so the live preview is clear inside. Solid white border, always (its
  outer edge is exactly the box's edge); a faint green wash appears when Rust reports a palm; a green ring runs round it from
  the top centre, clockwise, for `hold_ms` (1.2 s); a small green dot (white rim) marks the centre
  of the palm on the preview. The ring is a CSS animation that Rust's `holding` flag starts and
  stops, so it does not stutter at the sampling rate. No text sits in or on the box, and there is
  no brand line on the attract screen. Rejected after trying them on the tablet: a status pill
  ("GOT IT" read as a button), a second rectangle or a ring around the hand (looked like a second
  box / too loud), a hand silhouette in the box (clashed with the real hand). The UI reports the box's place in the *frame*
  (`ipc/frameGeometry.ts`: `object-fit: cover` crop and mirroring, tested) every 500 ms.
- Back leaves the booth (hardware back via the plugin's `backPressed`, plus a small "Back"
  pill on the attract screen); the original had no way out of a session at all.
- Fonts: Bun inlines small assets into the CSS as `data:` URIs, which the strict CSP
  (`default-src 'self'`) forbids, so `build.ts` extracts any inlined font back into
  `dist/fonts/*.ttf` and **fails the build** if a `data:` URI remains. (Absolute
  `/fonts/…` URLs were tried first; Bun refuses to resolve them.)

## Layout decisions

- Portrait vs. landscape is pure CSS (`@media (orientation: portrait)`), not JS.
- The review strip's photos `flex` to the available height, so a tall strip never runs under
  the footer on short screens (found by measuring `getBoundingClientRect` in the real app).
- With a **native preview** camera the WebView background is transparent
  (`body:has(.booth--native)`), so the CameraX layer behind it shows through; opaque screens
  (strip review, error) cover it.

## Accessibility and Maestro selectors

Maestro reads the WebView's **accessibility tree**, not pixels, so every interactive element
has visible text or an `aria-label`: `Settings` (gear), `Back`, `Continue →`, `Dismiss`,
slider/checkbox/text `aria-label`s equal to their visible label, `Dev` toggle. Prefer text over
coordinates. Pills that fill (`Tap to start photoshoot`, `Take another strip →`) need
`extendedWaitUntil` ≥ 4 s after the tap for the fill plus the backend transition.

While the camera cannot take a photo, the start pill is a disabled `<button>`, which Android
reports as `enabled=false` (checked with `uiautomator dump`). Taps on it are ignored, so flows
should tap with `enabled: true` (Maestro then waits out the "Connecting to camera…" phase).

Maestro matches the **whole** text of an accessibility node as a regex, and it merges what a
control contains, so a few selectors must be patterns (learned running the flows on the tablet):

| On screen | Maestro sees | Selector |
|-----------|--------------|----------|
| A camera card | one node: `Test Camera Test mode • Fast capture • No hardware required` | `"Test Camera.*"` |
| `{n} SHOTS` | two nodes: `3` and ` SHOTS` | `".*SHOTS"` |
| The strip caption | one long node starting `VIRTUAL PHOTO STRIP SAVED — COPIES…` | `"VIRTUAL PHOTO STRIP SAVED.*"` |
| An open-event card (Settings → Guest Portal) | name, venue and date in one node | `"Smith wedding.*"` |
| The portal line on the camera picker | one node | `"Portal: .*"` |

The Guest Portal section in Settings (`PortalSettings.tsx`, session 09) follows the same rules:
text fields labelled `Portal address`, `Enrolment code`, `Booth name`; buttons `Enrol booth`,
`Choose event` / `Change event`, `Use this event` / `Switch to this event`, `Cancel`,
`Clear event` then `Stop sending photos`, `Unenrol booth` then `Unenrol`, and `Remove enrolment` for a damaged one. The
confirmations are separate views with their own heading (`Use this event?`, `Switch event?`,
`Stop sending photos to {event}?`,
`Unenrol this booth?`), not dialogs, so a flow can wait for the heading.

The upload status (session 10) is operator-only: the guest screens are unchanged.

| On screen | Selector |
|-----------|----------|
| The upload badge on the camera picker | `role=status`, `aria-label="Upload status"`; its text starts `Uploads` (`"Uploads.*"`) and its class is `upload-badge--{ok,busy,offline,attention}` |
| Settings → the queue section | legend `Upload Queue`; counts in one node `Queued N · Uploading N · Needs attention N` (`"Queued.*"`) |
| An entry | `Session {id} · shot {n}` and the reason; buttons `Retry`, `Delete…` (then the heading `Delete this photo from the booth?`, buttons `Delete from booth` / `Cancel`), or `Dismiss` for a shot that wasn't queued |

The badge's wording (`uploadText.ts`) picks the most urgent state; Rust supplies the facts
(`OutboxStatus` from `outbox_status` and `portal://outbox`, kept in the store as `outbox`). The
list is fetched with `outbox_items` whenever the status changes.

## The post-shoot screen (session 13)

`StripReview` takes a `share` from `portal_session_qr` (asked once per session by
`useSessionShare`; Rust decides, see [Booth-Upload.md](./Booth-Upload.md) → "The post-shoot QR
code"). Three states, plus a moment of waiting:

| `share` | Right-hand column |
|---|---|
| `qr` | **Scan for your photos** (headline), "Opens on your phone. Save them or share them, no app needed.", the QR code, *Take another strip →* |
| `event_gallery` | **Looking good.**, "Your photos will be in the event gallery.", *Take another strip →* |
| `none` (not enrolled, no event, test camera, or the call failed) | as before the portal: the "VIRTUAL PHOTO STRIP SAVED — COPIES WILL BE AVAILABLE AFTER THE EVENT" notice, **Looking good.**, *Take another strip →* |
| `null` (Rust hasn't answered, milliseconds) | hidden (`visibility: hidden`), so the old notice never flashes up before the QR code |

The strip, the footer timer ("RETURNING TO PHOTOBOOTH") and *Take another strip →* are the same
in every state, so the Maestro flows (which run with the test camera, `none`) are unchanged.
The copy follows the design starter (`wiki/portal/design/post-shoot.html`), in the booth's own
type (Geist, the review's 56 px headline) on its dark review background. The design's "Back to
the start in 20 s" and *Done* button are the booth's existing footer timer and *Take another
strip →*: a second way out would compete with the QR code. The "after the event" notice stays
only without the portal, where it is still true (the operator hands out copies from the SD card).

**QR sizing.** `min(380px, 48vh)` square in a white tile with a 20 px radius (the SVG carries its
own 4-module quiet zone, which the radius never reaches). The Pad 6's WebView is **1152 × 720
CSS px** (2880 × 1800 at DPR 2.5, measured with `wm density`), so the code is 48vh = 345 CSS px
= 862 device px, about 7 cm at the screen's 309 ppi: the most the column fits beside the
headline, the line of copy and the pill. A staging link is a version-6 code (41 modules plus the
quiet zone, error correction L), so each module is about 1.4 mm. The tile is plain white on the
dark background, so booth lighting can't wash out its contrast. Measured on the tablet: the
finder patterns span 709 device px, and OpenCV decodes the code from a plain `screencap`.

The QR headline is `min(56px, 4.4vw)`: at 56 px "Scan for your photos" (516 px) wrapped in the
Pad 6's 504 px column, found on the tablet; a desktop browser at 1280 px didn't show it.

**Selectors:** heading `Scan for your photos`; `role=img` with `aria-label="QR code for your
photos"` (the SVG inside is `aria-hidden`); text `Your photos will be in the event gallery.`.
The progress bar's `aria-valuemax` is now the session's `auto_return_total`, not the setting.

## Camera problems: one voice, and no photo you cannot take

`cameraBanner` (in `store/store.ts`) is the single answer to "can the guest take a photo?" on the
attract screen: `null` when the camera is fine, otherwise the text to show ("Connecting to
camera…", "Camera disconnected", or the backend's error message). Three things follow from it:

- the banner is shown exactly when it is non-null, with *Retry connection* unless connecting;
- the **start pill is disabled** while it is non-null (greyed out, taps ignored): there is no
  point in starting a session the camera cannot serve, and a guest who did would only get an
  error screen;
- a **toast whose text contains the banner's message is not shown**. The backend reports a failed
  connect twice, as a camera status and as the rejected `camera_connect` command (for example
  "camera I/O error: Camera permission was denied…" next to "Camera permission was denied…").
  Mid-session there is no banner, so there the toast is the only place the problem appears.

Suppressing by containment, rather than deleting the toast from the connect call, keeps the
failures that never change the camera's status (a live view that could not start) visible.
Checked on the tablet with the permission denied: one message, pill disabled.

## Strip photos: ready before the strip appears

The camera's JPEGs are full size (6000×4000, ~10–20 MB). Fetching and decoding three of them the
moment the strip appeared took about a third of a second on the tablet (up to 0.8 s). The booth
now prepares each photo while the guest is on the next countdown:

1. When the session announces `flash` (shot *n* is captured and stored; the state carries its
   `session_id`), `photoPrefetcher` fetches `/photo/<session>/<n>` as a Blob.
2. It decodes the Blob straight to strip size (`createImageBitmap(blob, { resizeWidth: 1280 })`),
   draws it to a canvas and keeps the result as a ~100 KB in-memory JPEG (`blob:` URL).
3. `PhotoStrip` asks the prefetcher for each photo's URL (`useSyncExternalStore`): the small copy
   if it exists, otherwise the original. The full-size data is let go; the original stays
   available at its `booth://` URL.
4. Returning to attract (or leaving the booth) revokes every small copy.

Photos under 1 MB (the test camera's) are not shrunk; any failure along the way just leaves the
strip on the original URL.

**Measured on the tablet** with the test camera temporarily returning a 24 MP, 9.7 MB JPEG (3 runs
each, a small sample; DevTools over adb, scripts not kept): the strip's first two photos were
visible ~10 ms after it appeared instead of ~185 ms (320 ms in an earlier batch); the third was
unchanged at ~175 ms, because it is captured only ~0.3 s before the strip shows and so is still
being prepared. Page smoothness during the session: longest frame gap 84–98 ms with the prefetch
(baseline 14–104 ms).

**What did not work** (so nobody retries it): (1) holding a full-size `Image` and calling
`decode()` — the strip's own `<img>` still paid 400–700 ms on some runs, because the browser
evicts 24 MP bitmaps; (2) `createImageBitmap(<img>)` — it runs on the main thread and froze the
live preview for ~280 ms per photo, three times a session; (3) exporting the canvas without a
CORS response — "tainted canvas" error. Decoding a Blob runs off the main thread; that and the two
cross-origin allowances (CORS header, `connect-src`) are what make it work. See
`Tauri-App.md`.

## Developer panel

Visible only when the selected camera is the test camera **and** the backend accepts the
`dev` capability (probed by calling `logs_recent` once). A release build rejects it, so the
panel is simply absent: guests can never reach fault injection. Buttons: Start session, Skip
countdown, Fail next capture, Disconnect camera, Slow next capture (5 s), Palm in the box / Palm
away (drives the whole gesture path without a hand), Reset settings, plus
a live tail of the two backend events.

## How it was verified

- `bun run typecheck`, `bun test` (94 tests: every IPC wrapper, the painter's keep-latest
  behaviour, store/bridge ordering rules, every session-state view, every screen, the app
  shell and back-button path, using `@tauri-apps/api/mocks`), `bun run build`.
- The real Tauri app (Windows, WebView2, test camera) was driven over the DevTools protocol:
  picker → booth → live frames streaming (pixel colour cycling) → 3-shot session → strip with
  all photos loaded from `booth://` at 960×640 → injected capture failure → **Try again** →
  take another strip → auto-return → injected disconnect → banner → **Retry connection** →
  live view resumed → settings change persisted to `settings.json`.
- **Not verified:** touch behaviour on the tablet, orientation changes, native-preview
  transparency (needs the Android build), and the Android back button end to end.

## Known limitations

- Slider changes write `settings.json` on every step (small atomic writes; fine at this scale).
- Dev-only `console.log` streaming needs `bun run dev` (not the production bundle).
- Fill animation duration is a module constant (`uiConfig.fillMs`), not a setting.
