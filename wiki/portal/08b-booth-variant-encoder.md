# 08b — Booth variant encoder (pure Rust, measured on the tablet)

**Goal:** `photobooth-core` turns a camera JPEG into the two variants the portal stores (D14):
`thumb` (fit 480×480, q75) and `hd` (fit 2560×2560, q85), baseline sRGB JPEGs with the EXIF
orientation applied and **no metadata**. The session measures the encode time and the real Sony
JPEG size on the Xiaomi Pad 6, which the spike could only estimate.

- **Depends on:** 08 (the `EncodedShot` type the outbox accepts).
- **Unlocks:** 10.
- **Device check:** automated (encode timings and sizes from real Sony captures on the tablet,
  logged by a debug-build-only probe; see Verify).

**Why this is its own session, and why it sits here.** The encoder is pure Rust in
`photobooth-core`, like the outbox, and has nothing to do with HTTP or the UI, so it belongs to
the booth core rather than to session 10, which is already the critical device session (upload
loop, status UI, airplane-mode gate). Running it before 09 and 10 also tests D14's one open
risk (on-tablet encode time) before anything is built on top of it. Together with 08 it
would not fit one context window: crate selection, orientation handling, metadata tests and a
tablet run are a session's worth of work.

## Read first
- DESIGN.md §3 (D1, D14), §7 (variant table and the metadata paragraph), §9.1 (the header
  rules), §10 item 3 (encoding in the outbox flow), §13 (malicious image row), §17 (booth tests,
  release gates 3 and 5).
- `wiki/portal/spike/RESULTS.md`: Q5 (orientation), Q6 (metadata), Q7 (measured sizes and the
  2560/q85 choice), Q8 (Sony size, not verified), Q10 (the on-tablet estimate and the header
  allowlist).
- `wiki/portal/spike/scripts/booth_variants.py` (the spike's reference pipeline) and
  `jpeginfo.py` (APP1/TIFF parsing and retagging, useful for building test inputs).
- `crates/photobooth-core/src/outbox/` (from 08), `photo_store.rs`; `wiki/Core-Domain.md`.
- `crates/photobooth-core/src/session.rs` (where `StripReview` is reached and where
  `PhotoStore` is cleared), `apps/booth/src-tauri/src/state.rs`.
- `wiki/Tauri-App.md` (logging, `logs_recent`) and `wiki/Android-Build.md`.

## Scope
1. **Crate choice** (record the decision and numbers in the PR and `wiki/Booth-Upload.md`):
   one JPEG decode, resize and encode stack, for example `zune-jpeg` + `fast_image_resize` +
   `jpeg-encoder`, or `turbojpeg`. `jpeg-encoder` is already a `photobooth-core` dependency (the
   mock camera uses it), so reusing it is the default for encoding. Criteria, in order: builds for `aarch64-linux-android` in the
   existing Android build without extra toolchain steps; DCT-scaled decode (1/2) or an equally
   fast path; can write a JFIF-only file with no other APPn; small dependency footprint. Measure
   the candidates on the PC with the same inputs before choosing. Any crate not named in DESIGN
   §5 needs a one-line justification.
2. **`crates/photobooth-core/src/variants/`:**
   - `encode_variants(jpeg: &[u8]) -> Result<EncodedShot, VariantError>`.
   - Read the EXIF orientation (APP1 TIFF tag 0x0112) with a small parser or a lean crate;
     missing or invalid means 1. Apply all 8 orientations.
   - Decode (scaled where possible), orient, resize with a Lanczos-class filter to fit 2560 and
     480 on the long edge (never upscale), encode hd at q85 and thumb at q75.
   - The output is baseline (SOF0, one scan) and has SOI, APP0 JFIF, DQT, DHT, SOF0, SOS, EOI
     and nothing else (no APP2, no APP14 needed). Add a small Rust header check
     (`variants::check_segments`) with the same rules as the Worker (DESIGN §9.1: allowlist,
     SOF0 only, final EOI) and run it on every output (it is cheap). A failure is an encoder bug and
     returns `VariantError`, so a bad variant never reaches the outbox.
   - `EncodedShot.width`/`height` are the hd dimensions after orientation.
   - At most one decoded frame in memory at a time.
3. **Debug-build-only measurement probe** (`#[cfg(debug_assertions)]`, so release builds
   don't contain it; no new command, capability or UI):
   - The probe is a debug-only implementation of 08's `OnSessionComplete` hook, with no
     enrolment or event gate (those don't exist until 09/10). It receives the session's owned
     `Bytes` clones at `StripReview` (it must not read `PhotoStore` later: the store is cleared
     on return to attract or on "take another"), and encodes them one at a time on a background
     task.
   - Per shot it logs the input bytes, input dimensions, orientation, decode/resize/encode
     milliseconds, total milliseconds and output sizes through the normal log path
     (`logcat -s Photobooth`, `logs_recent`), then drops the output.
   - It never writes images to disk and never sends image bytes over IPC. Session 10 replaces it
     with the real session-complete hook.
   - The debug APK builds Rust in the dev profile (opt-level 0), which would make pure-Rust
     decode and resize look many times slower than in release. Add
     `[profile.dev.package.<crate>] opt-level = 3` in the root `Cargo.toml` for the chosen
     decode, resize and encode crates and for `photobooth-core` (the repo already does this for
     `jpeg-encoder`), so the probe times optimised code. Say in the PR which crates it covers.
4. **Docs:** add the encoder to `wiki/Core-Domain.md` (what it guarantees: orientation applied,
   no metadata) and start the encoder section of `wiki/Booth-Upload.md`.

## Out of scope
- Calling the encoder from the session flow, and enqueueing (10). Any upload code (09–10).
- Colour management: the camera shoots sRGB and no ICC profile is written (DESIGN §7).

## Verify
```bash
cargo fmt --all -- --check
cargo clippy -p photobooth-core --all-targets -- -D warnings
cargo clippy -p photobooth --all-targets -- -D warnings
cargo test -p photobooth-core
cd apps/booth && bun install --frozen-lockfile && bun run typecheck && bun test && bun run build   # build first: the photobooth crate embeds dist
cargo test -p photobooth
```
Tests must cover (inputs generated inside the test, never guest photos):
- orientations 1–8: output dimensions and pixel orientation (a test pattern with a marked
  corner);
- long edges: a 6000×4000 input gives 2560×1707 and 480×320, a portrait input the transpose,
  and an input smaller than 480 px is not upscaled;
- an input carrying APP1 EXIF with GPS, body and lens serial numbers, plus XMP, APP13 and a COM
  segment, gives outputs where `check_segments` passes and none of those bytes appear;
- a corrupt or truncated input returns `VariantError`, never a panic.

**Automated device check** (agent, tablet over Wi-Fi adb, real Sony camera):
1. Install the debug build (`pwsh apps/booth/scripts/build-android-debug.ps1 -Install`). Take
   10 sessions (30 shots) with the real camera, driving the UI with `adb shell input tap`.
2. Read the Sony JPEG size from the `downloading the captured object` log line for each shot
   (spike Q8).
3. Collect the probe's per-shot timings from `logcat -s Photobooth` (one line per shot,
   logged during each session's review screen).
4. Confirm from the PR's `Cargo.toml` diff that the measured crates build at opt-level 3 in the
   dev profile; otherwise the numbers are not valid for the gate.
5. Pull nothing off the device except log lines. Report p50, p95 and max total ms per shot,
   peak memory if visible (`dumpsys meminfo com.jc.photobooth.tauri`), and output sizes.
6. **Gate:** if p95 is over 3 s per shot, stop and report to the user before 10 starts, and
   D14 is revisited. Derivation, on DESIGN §17 gate 5's metric (p95 shot-to-READY under 15 s):
   shot 1 waits about 10 s for shots 2 and 3 (3 s countdown plus capture and transfer, each),
   then needs its encode and about 1 s of upload. At 3 s per shot that is about 14 s, the
   tightest shot of the session; the last shot finishes well inside it.
   The spike's estimate is 0.6–1.6 s.

## Done when
- [ ] All the tests above pass with no suppressions.
- [ ] Encode p50/p95 per shot and the real Sony JPEG size (Q8) are measured on the tablet and
      recorded in PROGRESS.md and `wiki/Booth-Upload.md`, or marked **not verified** with the
      reason.
- [ ] The probe exists only in debug builds (checked by building release once, or by the
      `cfg` attribute and a note in the PR), and adds no command or capability.

## Hand-off
- `wiki/Booth-Upload.md`: the crate decision and its numbers, the on-tablet timings, the Sony
  JPEG size, and why the booth (not Cloudflare) makes the variants (D14, spike Q6/Q10/Q11).
- `wiki/Core-Domain.md`: the encoder's guarantees.
- PROGRESS.md entry, including the gate result.
