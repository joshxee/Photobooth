# 06 — Upload intent, variant upload and validation

**Goal:** the core live-delivery path. A device declares a photo and its two booth-made
variants (D14), uploads each variant to a Worker-signed URL, and gets the photo back READY once
both are stored and checked. It must be idempotent, safe to retry and safe under concurrency,
with no queue and no image decoding in the Worker.

- **Depends on:** 05, and the 01 spike results.
- **Unlocks:** 07, 10, 11, 16.
- **Device check:** n/a.

## Read first
- DESIGN.md §3 (D5, D6, D14), §6 (`photos` columns), §7 (storage layout and variants), §9 (all
  of it), §13 (rows for upload URL replay and malicious or oversized image), §17 (Worker
  tests, release gate 3).
- `wiki/portal/spike/RESULTS.md`: Q1 (R2 `sha256` error 10037), Q2 (streamed put), Q6 (why
  metadata is enforced here), Q9 (what local `wrangler dev` reproduces), Q10 (the header walk
  and caps), Q11 (CPU).
- `wiki/portal/spike/worker/` for the spike's put + range read + header walk (reference only;
  rewrite it properly with tests).
- `wiki/Portal.md`.

## Scope
1. **`POST /v1/device/photos`** (device auth, rate-limited per device):
   - Validate with zod: `eventId`, a UUID `clientPhotoId`, `sessionId`, `shot`, an ISO capture time, the
     HD `width` and `height` (long edge ≤ 2560), and
     `variants: {thumb: {bytes, sha256}, hd: {bytes, sha256}}` with `thumb.bytes` ≤ 200 KB and
     `hd.bytes` ≤ 3 MB (`too_large` otherwise).
   - The event must be OPEN and not deleted.
   - Use the atomic insert from 03 (photo limit and uniqueness).
     - Existing row, same hashes and event: return its state. READY means nothing to upload;
       PENDING returns URLs only for the variants not yet stored.
     - Existing row, REJECTED: `200 {state: "REJECTED", reason}` with no URLs (the booth marks
       it needs attention).
     - Existing row, different hashes or event: 409 `conflict`.
     - Over the limit: 409 `photo_limit`.
     - Event closed: 409 `event_closed`.
   - A PENDING result returns `uploads`, keyed by variant, each a descriptor: method, URL,
     headers and `expiresAt`.
2. **`lib/uploadUrl.ts`** (behind a small signer interface, so SigV4 can replace it, §9.4):
   - An HMAC-SHA256 (`UPLOAD_KEY`) signature over `photoId|variant|bytes|sha256|exp`. The URL
     is `/v1/device/uploads/{photoId}/{variant}?exp=&sig=`, valid for 15 minutes.
   - Verification is timing-safe.
3. **`PUT /v1/device/uploads/{photoId}/{variant}`**, authorised by the signed URL only, with no
   bearer header (so it can later be swapped for presigned R2):
   - Verify the signature and expiry; expired returns 410 `upload_expired`.
   - The photo must exist. READY returns 201 READY without writing (idempotent); REJECTED
     returns 422 `invalid_image` without writing. Its device must not be revoked, and its event
     must not be deleted.
   - `Content-Length` must equal the declared bytes, and the content type must be `image/jpeg`.
   - `MEDIA.put("events/{eventId}/{photoId}/{variant}.jpg", request.body, {sha256})`, streamed,
     not buffered. R2 error 10037 maps to 422 `hash_mismatch` (nothing is stored).
   - Call `processPhoto()`, then return 201 READY (both variants stored) or 200 STORED (the
     first one). The MVP never returns 202 (§9.2).
4. **`domain/jpegHeaders.ts`**, pure, over the first 64 KB of bytes plus the last 2 bytes:
   - SOI first; then only APP0 (`JFIF`), APP14 (`Adobe`), DQT, DHT, DRI and **SOF0 (baseline)**
     before SOS; SOS must start within the 64 KB. Baseline means a single scan, so no segment
     can hide between scans past the walked range (spike RESULTS.md, header-walk note).
   - The object must end in EOI (`FFD9`).
   - Any other marker (APP1 EXIF/XMP, APP2, APP13 IPTC, COM, other APPn, SOF1+ including
     progressive) fails with a named reason.
   - Returns the SOF dimensions.
5. **`domain/processPhoto.ts`** (with D14 it validates one stored variant and publishes the
   photo once both are stored; DESIGN §9.4), which takes no HTTP types and receives the bucket, the
   database and a clock through small interfaces:
   - Range-read 0–64 KB and the last 2 bytes of the stored object and run the header walk. The hd SOF size must equal
     the declared `width`×`height`; the thumb's long edge must be ≤ 480 px.
   - On failure: delete the object, mark the photo REJECTED with `invalid_image` and the reason,
     and return 422.
   - On success: `UPDATE photos SET <variant>_stored=1`, then the conditional
     `UPDATE … SET state='READY', published_at, width, height, variant_bytes WHERE id=? AND
     state='PENDING' AND thumb_stored AND hd_stored AND event not deleted`. Zero rows changed
     means re-read and return the current state.
6. **Tests** (Vitest, real local R2 and D1; local R2 enforces `sha256` like production, Q9):
   - Intent: new, duplicate, mismatch, closed, limit, size caps; READY short-circuit; a PENDING
     re-intent returns only the missing variant's URL.
   - Signed URL: tampered photoId, variant, bytes, sha or exp; expired.
   - PUT: wrong length, wrong type, bad hash (422, nothing stored), revoked device, deleted
     event.
   - Header walk table tests: valid baseline JFIF; APP1 with GPS EXIF; APP1 XMP; APP2 (ICC);
     APP13; COM; progressive (SOF2); trailing data that doesn't end in `FFD9`; missing EOI;
     PNG renamed `.jpg`; truncated before SOS; SOS past 64 KB. (Only the last 2 bytes are
     checked, so a tail that itself ends in `FFD9` passes: that is part of the accepted residual
     risk, DESIGN §13.)
   - A REJECTED photo: re-intent returns REJECTED, a PUT returns 422.
   - hd SOF size different from the declared size → REJECTED, object deleted.
   - thumb with a long edge over 480 px → REJECTED, object deleted.
   - Happy path: thumb → 200 STORED, hd → 201 READY, in either order.
   - The same PUT twice gives one READY with identical keys.
   - Two concurrent PUTs of the last variant give one READY and no error.
   - Failure after the object is written but before the UPDATE: still PENDING, and a retry
     gives READY.
   - Event deleted between the two variants: no READY.
   - Fixtures are built in a test helper by splicing segments into a minimal valid JPEG (no
     image library), plus a committed synthetic thumb/hd pair for the smoke script. No real
     guest photos.

## Out of scope
- Guest serving (11). Booth client and encoder (08b–10). Staging checks (07).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test
bun run scripts/smoke.ts --base http://localhost:8787   # create the script here: enrol → intent → PUT thumb → PUT hd → READY, using DEV_AUTH for setup
```

## Done when
- [ ] Every DESIGN §9.2 claim (idempotency, concurrency, integrity, partial failure, closing)
      has a named test.
- [ ] Every header-walk rejection reason has a named test, and a rejected variant leaves no
      object in R2.
- [ ] `processPhoto()` and `jpegHeaders.ts` have no imports from Hono or Request/Response.
- [ ] `scripts/smoke.ts` passes locally.

## Hand-off
- `wiki/Portal.md`: the upload path (the §9.4 verdict in brief), why the Worker validates but
  never decodes (D14, spike Q6/Q10), the accepted malicious-image risk, the spike numbers, why a
  202 exists, and that everything here is verified locally (nothing depends on a binding that
  behaves differently remotely).
- PROGRESS.md entry.
