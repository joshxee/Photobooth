# 11 — Guest access and gallery API

**Goal:** a guest with a valid share link gets a scoped cookie and can list and fetch an event's
READY, non-hidden photos. Every other case returns a generic 404, and rotation or suspension
takes effect immediately.

- **Depends on:** 06.
- **Unlocks:** 12, 14, 16.
- **Device check:** n/a.

## Read first
- DESIGN.md §3 (D9, D10, D11), §8 (guest table), §11 (all of it), §13 (rows for cross-event
  access, leaked link and denial of wallet).
- `apps/portal/contract/fixtures/gallery.*`.

## Scope
1. **`POST /e/{publicId}/api/session {token}`:**
   - Rate-limited per IP.
   - Timing-safe comparison of the token with the event's `share_token`. The event must be
     LIVE, not deleted and not expired.
   - Set the cookie: name `g`, value `HMAC(SESSION_KEY, eventId|accessVersion|exp)`,
     `Path=/e/{publicId}`, `Secure`, `HttpOnly`, `SameSite=Lax`. `exp` is the earlier of
     gallery expiry and 30 days.
   - Every failure returns the same 404.
2. **`middleware/guestAuth.ts`:** check the cookie signature and `exp`, load the event by
   `publicId`, and require it to be LIVE, not deleted, not expired, with a matching
   `access_version`. A failure returns 404 and clears the cookie.
3. **`GET /e/{publicId}/api/photos?cursor&session&limit`:**
   - Returns READY, non-hidden photos for this event only, newest first; default 24, maximum
     100.
   - The optional `session` filter accepts only IDs belonging to this event.
   - The response includes `eventOpen` (to drive polling), the event name and local date, the
     next cursor, and the contact values (address, email) for the footer.
   - Cheap for polling: one indexed query.
4. **`GET /e/{publicId}/m/{photoId}/{variant}[?download=1]`:**
   - Follows the four steps in DESIGN §11 *Media*, then streams from R2 with the headers listed
     there.
   - `download=1` adds `Content-Disposition: attachment` with a safe filename
     (`<event-slug>-<n>.jpg`, ASCII only).
   - Variant is one of thumb, preview or full; anything else returns 404.
5. **Tests:**
   - Valid session flow.
   - Wrong token, suspended, deleted, expired → identical 404s.
   - After rotation, both the old cookie and the old token get 404.
   - Cross-event: a photo ID from event B under event A's path → 404. A session ID from event B
     → empty result or 404.
   - Hidden, PENDING and REJECTED photos never listed or served.
   - Cookie attributes exact.
   - Pagination is stable across inserts.
   - Download headers.
   - CSP and headers on media responses.

## Out of scope
- The gallery UI (12). Admin media proxy and moderation (15). Purge (16).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test
bun run scripts/smoke.ts --base http://localhost:8787   # extend: after READY, open session with the token, list, fetch each variant, download
```

## Done when
- [ ] Every row of DESIGN §11 *Media* and the cross-event row of §13 has a named test.
- [ ] Rotation and suspension take effect on the very next request (tested).
- [ ] The smoke test covers the guest path.

## Hand-off
- `wiki/Portal.md`: the guest access model (fragment → cookie, stateless cookie plus
  `access_version`, path-scoped cookies for multiple events, why a generic 404), and the cache
  headers reasoning.
- PROGRESS.md entry.

