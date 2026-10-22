# 09 — Booth portal client, enrolment and event selection

**Goal:** the booth can be enrolled against a portal, can pick an OPEN event with
confirmation, and has a real `PortalClient` (reqwest) that speaks the contract. It is proven by
the shared fixtures and against local `wrangler dev`.

- **Depends on:** 05, 08.
- **Unlocks:** 10.
- **Device check:** automated (enrolment and event selection on the tablet against staging if
  07 has merged, otherwise against a reachable dev machine). Evidence: screenshots and a
  `uiautomator dump`.

## Read first
- DESIGN.md §8 (device API), §10 items 1–2, §13 (row for stolen tablet).
- `wiki/Tauri-App.md` (commands, capabilities, security posture), `wiki/Frontend.md`
  (screens, store, Maestro selectors), `wiki/Booth-Upload.md`.
- `apps/booth/src-tauri/src/commands.rs`, `dto.rs`, `state.rs`, `capabilities/*.json`;
  `apps/booth/src/screens/Settings.tsx`; `apps/booth/src/ipc/`.
- `apps/portal/contract/fixtures/device.*` (including the per-variant intent and upload
  fixtures).

## Scope
1. **Rust contract types** (`apps/booth/src-tauri/src/portal/types.rs`, or core if they're pure
   and shared): serde structs for every device message. A test loads every
   `apps/portal/contract/fixtures/device.*.json` via `include_str!` and round-trips it. A
   fixture change that breaks Rust fails `cargo test`.
2. **`HttpPortalClient`** implementing `PortalClient` (reqwest, rustls, timeouts, no redirects
   to other hosts):
   - The bearer is attached only to requests whose origin is the configured portal URL. Each
     variant's upload PUT sends exactly that `uploads.<variant>.headers` and **no bearer**.
   - Maps the intent's `uploads` map (only the variants the server still needs), a REJECTED
     intent (→ `Rejected{reason}`) and the PUT's 201 READY / 200 STORED / 202 to 08's outcome
     enums.
   - Sends `X-Outbox-Depth` and the app version.
   - Maps HTTP responses and error codes to the outcome enums.
   - Unit tests use a local mock server, or a trait-level fake if adding a mock-server crate is
     not justified.
3. **Portal settings and credential:**
   - Settings gain `portal_url` (default per build environment) and `selected_event`
     (`{id, name, local_date}`), both validated like the existing settings.
   - The credential is stored in app-private storage as a separate file with mode 0600 where
     supported, **never** in settings JSON, never logged, and never sent over IPC to the
     WebView.
4. **Commands** (in `default.json` only where the operator UI needs them, with the
   least-privilege review noted):
   - `portal_status`: enrolled, portal URL host, selected event.
   - `portal_enrol{code, name}`.
   - `portal_unenrol`: deletes the credential, with confirmation in the UI.
   - `portal_events`.
   - `portal_select_event{id}`: re-fetches it and requires that it is OPEN.
   - `portal_clear_event`.
5. **Operator UI** (in Settings, operator-facing):
   - An enrolment form (URL, code, device name).
   - The event list → a confirmation screen showing the event name, the local date and "Photos
     from this booth will appear in this event's gallery" → selected.
   - The selected event shown in the operator status area.
   - Switching events requires a confirmation.
   - Add Maestro-friendly selectors per `wiki/Frontend.md` conventions, and `bun test` tests.

## Out of scope
- The drain loop and upload status UI (10). The post-shoot QR (13).
- Android Keystore wrapping (post-MVP, DESIGN §10).

## Verify
```bash
cargo fmt --all -- --check && cargo clippy -p photobooth --all-targets -- -D warnings && cargo test -p photobooth
cd apps/booth && bun run typecheck && bun test && bun run build
# local integration: apps/portal `wrangler dev` + seed; run the desktop booth build against http://photos.localhost:8787; enrol and select an event
```
Device (automated): install the debug APK, enrol with a code created through the staging admin
API (service token), and select an event. Capture screenshots, and confirm via `run-as` that
the credential file exists and is absent from the settings JSON.

## Done when
- [ ] The fixture round-trip test covers every device fixture.
- [ ] The credential never appears in settings, logs or IPC payloads (a test asserts on the DTO
      and log output).
- [ ] Enrolment and event selection work on the tablet, with screenshots in the PR.

## Hand-off
- `wiki/Booth-Upload.md`: credential storage decision and limits (app-private storage, Keystore
  post-MVP), event selection UX reasoning, how the contract fixtures are consumed.
- `wiki/Tauri-App.md`: the new commands and their capability placement.
- PROGRESS.md entry.

