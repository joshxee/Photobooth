# 13 — Booth post-shoot screen with session QR (critical)

**Goal:** after each session the guest sees a QR code that opens the gallery filtered to their
shots, which arrive within seconds (the booth encodes the variants, then uploads them). The
post-shoot copy is redesigned for live delivery.

- **Depends on:** 10, 12. The device run needs 07 (staging).
- **Unlocks:** 17.
- **Device check:** **critical**. The agent runs the automated flow; then you scan with a real
  phone.

## Read first
- DESIGN.md §10 item 4, §11 (link format and session filter).
- `wiki/portal/design/post-shoot.*` and `design/README.md` criteria.
- `wiki/Frontend.md` (screens, copy parity notes, selectors), `wiki/Tauri-App.md`.
- `apps/booth/src/screens/BoothViews.tsx` (`StripReview`), `apps/booth/src/uiConfig.ts`
  (current copy, including "copies will be available after the event").

## Scope
1. **Gallery URL on the booth:**
   - When an event is selected, and every 5 minutes while selected, fetch
     `GET /v1/device/events/{id}` and cache `galleryUrl` in memory only.
   - If the gallery is not LIVE, there is no QR code, and the copy falls back to "Your photos
     will be in the event gallery".
2. **QR rendering** in Rust with the `qrcode` crate: a command `portal_session_qr{session_id}`
   returns an SVG string for `galleryUrl` with `&s={session_id}` appended to the fragment. It
   is least-privilege: it returns only the SVG, never the raw token separately.
3. **Post-shoot screen** (`StripReview`), per the design starter:
   - The strip as today, plus a QR code large enough to scan from about 1 m (at least 300 px on
     the tablet), and short copy, for example "Scan to get your photos now".
   - It stays legible in booth lighting.
   - Adjust the auto-return timer if the design calls for longer QR dwell, as a setting.
   - Revise the other copy that mentions "after the event" in `uiConfig.ts`.
   - Keep Maestro selectors stable or update them per `wiki/Frontend.md`.
4. **Tests:** `bun test` for screen states (QR present, gallery not LIVE, not enrolled or no
   event, which keeps today's behaviour), and a `cargo test` for the URL composition (fragment
   handling, session appended once).

## Out of scope
- An event-wide QR on the booth (admins print it from session 14). Printing.

## Verify
```bash
cargo fmt --all -- --check && cargo clippy -p photobooth --all-targets -- -D warnings && cargo test -p photobooth
cd apps/booth && bun run typecheck && bun test && bun run build
```
**Automated device flow** (agent, staging):
1. Run a session.
2. `screencap` the post-shoot screen and decode the QR from the screenshot (a small decoder
   script or a library in a dev-only script).
3. Open the decoded URL with `chrome-devtools-axi` in mobile emulation and assert all 3 shots
   appear as READY within 15 s of the session ending (this includes on-tablet encoding, about
   3 × the 08b per-shot time).

Attach screenshots and timings.

**Human once-over** (you): scan the QR code with your own phone (iOS and/or Android) from
about 1 m in booth lighting, confirm the shots arrive, download one, and check the copy reads
well. Tick it in PROGRESS.md.

## Done when
- [ ] The automated flow passes: QR decoded → gallery → 3 READY in under 15 s.
- [ ] The human scan is ticked, and the copy is approved.
- [ ] No-event and not-enrolled modes behave as before (tested).

## Hand-off
- `wiki/Frontend.md`: post-shoot screen states, new copy, QR sizing reasoning.
- `wiki/Booth-Upload.md`: gallery URL caching (memory only) and why the QR is rendered in Rust.
- PROGRESS.md entry.

