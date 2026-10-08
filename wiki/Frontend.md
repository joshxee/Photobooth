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

Visible strings are ported verbatim from `composeApp/.../ui/knockbox` so the Maestro flows
can be re-targeted rather than rewritten: "Select Camera", "Continue →", "Welcome to the
booth —\nraise your hand", "or", "Tap to start photoshoot", "Look at the lens", "VIRTUAL PHOTO
STRIP SAVED — COPIES WILL BE AVAILABLE AFTER THE EVENT", "Looking good.", "Take another strip
→", "RETURNING TO PHOTOBOOTH", "Retry connection", and the Settings labels ("Number of
Photos", "Countdown Seconds", "Photo Strip Display Time", "Current Configuration"). Layout,
tokens (paper/ink/forest), type sizes and animations (arrow bounce, numeral pop, 3 s pill
fill) follow the original too.

Deliberate differences:

- The test camera card is **"Test Camera"**, not "Mock Camera (Testing)" (it is a real
  backend now). Sony is **"Sony A7 III (USB)"**; the Wi-Fi card and "Sony API Discovery" are gone.
- **"raise your hand"** is kept verbatim although the gesture trigger is deferred, so today
  that line promises something the app does not do. The old native-camera path had the same
  mismatch. Change the copy when the gesture trigger lands (or sooner, if it confuses guests).
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
slider/checkbox/text `aria-label`s equal to their visible label, `Dev` toggle. Use
`tapOn: "<exact text>"`; prefer text over coordinates. Pills that fill (`Tap to start
photoshoot`, `Take another strip →`) need `extendedWaitUntil` ≥ 4 s after the tap for the
fill plus the backend transition.

## Developer panel

Visible only when the selected camera is the test camera **and** the backend accepts the
`dev` capability (probed by calling `logs_recent` once). A release build rejects it, so the
panel is simply absent: guests can never reach fault injection. Buttons: Start session, Skip
countdown, Fail next capture, Disconnect camera, Slow next capture (5 s), Reset settings, plus
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
