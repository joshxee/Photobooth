# 05 — Devices, enrolment and the device API

**Goal:** admins create and revoke devices, a booth swaps a one-time code for a credential, and
an authenticated device can list OPEN events and fetch an event's gallery URL.

- **Depends on:** 04.
- **Unlocks:** 06, 09.
- **Device check:** n/a.

## Read first
- DESIGN.md §3 (D8, D9), §6 (`devices`), §8 (device table and the `X-Outbox-Depth` paragraph),
  §12 (devices), §13 (rows for stolen tablet and enrolment-code guessing).
- Cloudflare docs: the Workers Rate Limiting binding.
- The contract fixtures `device.*`.

## Scope
1. **Admin routes** (`routes/admin/devices.ts`):
   - `POST /api/devices {name}` creates a device and returns the 8-character code **once**,
     storing only its hash and a 10-minute expiry.
   - `POST /api/devices/{id}/code` re-issues a code (any old one becomes invalid).
   - `POST /api/devices/{id}/revoke`.
   - `GET /api/devices` returns name, enrolled, revoked, last seen, backlog and app version.
   - All of these are audited.
2. **Enrolment:** `POST /v1/device/enrol {code, name, appVersion}` on the gallery host.
   - Rate-limited per IP.
   - The code must be unused and unexpired. On success, create a 256-bit credential, store its
     hash, and clear the code (single use).
   - Every failure returns one identical error (no clue whether the code exists).
   - The response gives the credential once.
3. **`middleware/deviceAuth.ts`:**
   - Bearer credential → hash → device lookup; the device must be enrolled and not revoked.
   - Update `last_seen_at`, `last_backlog` (from `X-Outbox-Depth`, clamped 0–100000) and
     `app_version`. Throttle the write to at most once a minute per device to save D1 writes.
4. **Device routes:**
   - `GET /v1/device/events`: OPEN, non-deleted events.
   - `GET /v1/device/events/{id}`: detail, with `galleryUrl` only when the gallery is LIVE.
   - Response shapes come from the 03 fixtures.
5. **Tests:**
   - Code expiry, reuse and re-issue. The same error for every failure. Rate limit enforced
     (the binding simulated locally).
   - Revoked → 401. Unknown credential → 401.
   - Heartbeat fields written and throttled.
   - Events list filtering. `galleryUrl` hidden unless LIVE.
   - Responses equal the fixtures' shapes (parse them with the response schemas).

## Out of scope
- Photo intents and uploads (06). Booth-side code (09).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test
# local: create device via admin.localhost (DEV_AUTH) → enrol via photos.localhost → GET /v1/device/events with the bearer
```

## Done when
- [ ] The enrolment flow works locally end to end. The credential is stored only as a hash
      (check in Local Explorer).
- [ ] Revocation takes effect on the next request.
- [ ] Rate limiting is configured for enrolment, with namespace IDs in `wrangler.jsonc`.

## Hand-off
- `wiki/Portal.md`: why device credentials don't expire (revocation plus last-seen instead),
  the code entropy and rate-limit reasoning, and heartbeat throttling.
- PROGRESS.md: **note that booth session 09 may now start once 08 has merged.**

