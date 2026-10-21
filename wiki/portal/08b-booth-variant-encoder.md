# 08b — Booth variant encoder (pure Rust, measured on the tablet)

**Goal:** `photobooth-core` turns a camera JPEG into the two variants the portal stores (D14):
`thumb` (fit 480×480, q75) and `hd` (fit 2560×2560, q85), baseline sRGB JPEGs with the EXIF
orientation applied and **no metadata**. The session measures the encode time and the real Sony
JPEG size on the Xiaomi Pad 6, which the spike could only estimate.

- **Depends on:** 08 (the `EncodedShot` type the outbox accepts).
- **Unlocks:** 10.
- **Device check:** automated (encode timings and sizes from real Sony captures on the tablet,
  through a dev-only command; see Verify).

**Why this is its own session, and why it sits here.** The encoder is pure Rust in
`photobooth-core`, like the outbox, and has nothing to do with HTTP or the UI, so it belongs to
the booth core rather than to session 10, which is already the critical device session (upload
loop, status UI, airplane-mode gate). Running it before 09 and 10 also tests D14's one open
risk (on-tablet encode time) before anything is built on top of it. Together with 08 it
would not fit one context window: crate selection, orientation handling, metadata tests and a
tablet run are a session's worth of work.

## Read first
- DESIGN.md §3 (D1, D14), §7 (variant table and the metadata paragraph), §10 item 3 (encoder),
  §13 (rows for malicious image and metadata leak), §17 (booth tests, release gate 3).
- `wiki/portal/spike/RESULTS.md`: Q5 (orientation), Q6 (metadata), Q7 (measured sizes and the
  2560/q85 choice), Q8 (Sony size, not verified), Q10 (the on-tablet estimate and the header
  allowlist).
- `wiki/portal/spike/scripts/booth_variants.py` (the spike's reference pipeline) and
  `jpeginfo.py` (APP1/TIFF parsing and retagging, useful for building test inputs).
- `crates/photobooth-core/src/outbox/` (from 08), `photo_store.rs`; `wiki/Core-Domain.md`.
- `wiki/Tauri-App.md` (dev capability, `logs_recent`) and `wiki/Android-Build.md`.

## Scope
1. **Crate choice** (record the decision and numbers in the PR and `wiki/Booth-Upload.md`):
   one JPEG decode, resize and encode stack, for example `zune-jpeg` + `fast_image_resize` +
   `jpeg-encoder`, or `turbojpeg`. Criteria, in order: builds for `aarch64-linux-android` in the
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
   - The output has SOI, APP0 JFIF, DQT, DHT, SOF0, SOS, EOI and nothing else. Add a small Rust
     header check (`variants::check_segments`) with the same allowlist as the Worker
     (DESIGN §9.1) and run it on every output (it is cheap). A failure is an encoder bug and
     returns `VariantError`, so a bad variant never reaches the outbox.
   - `EncodedShot.width`/`height` are the hd dimensions after orientation.
   - At most one decoded frame in memory at a time.
3. **Dev-only measurement command** (in the `dev` capability only, like `test_inject`):
   `variants_bench` encodes every shot currently in `PhotoStore` and logs, per shot, the input
   bytes, input dimensions, orientation, decode/resize/encode milliseconds, total milliseconds
   and output sizes, through the normal log path (`logcat -s Photobooth`, `logs_recent`). It
   never writes images to disk and never returns image bytes over IPC.
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
1. Install the debug build. Take 3 sessions (9 shots) with the real camera.
2. Read the Sony JPEG size from the `downloading the captured object` log line for each shot
   (spike Q8).
3. Call `variants_bench` through the dev capability, and collect the per-shot timings from
   `logcat -s Photobooth`.
4. Pull nothing off the device except log lines. Report p50 and p95 total ms per shot, peak
   memory if visible (`dumpsys meminfo com.jc.photobooth.tauri`), and output sizes.
5. **Gate:** if p95 is over 5 s per shot, stop and report to the user before 10 starts
   (DESIGN §10: D14 is revisited). The spike's estimate is 0.6–1.6 s.

## Done when
- [ ] All the tests above pass with no suppressions.
- [ ] Encode p50/p95 per shot and the real Sony JPEG size (Q8) are measured on the tablet and
      recorded in PROGRESS.md and `wiki/Booth-Upload.md`, or marked **not verified** with the
      reason.
- [ ] `variants_bench` is reachable only through the `dev` capability.

## Hand-off
- `wiki/Booth-Upload.md`: the crate decision and its numbers, the on-tablet timings, the Sony
  JPEG size, and why the booth (not Cloudflare) makes the variants (D14, spike Q6/Q10/Q11).
- `wiki/Core-Domain.md`: the encoder's guarantees.
- PROGRESS.md entry, including the gate result.
