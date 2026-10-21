# 03 — Schema, data layer and the shared contract

**Goal:** the D1 schema, typed data access, zod schemas for every API body, and the JSON
fixtures that pin the contract for both the Worker (zod) and the booth (serde). After this
session the portal track and the booth track can run in parallel.

- **Depends on:** 02.
- **Unlocks:** 04, 08.
- **Device check:** n/a.

## Read first
- DESIGN.md §6 (data model), §8 (API: all three tables), §9.1 (intent and upload responses),
  §9.3 (error codes the booth reacts to), §11 (the gallery photos page).
- `wiki/Portal.md`.
- Cloudflare skill `wrangler` (D1 migrations). D1 docs on prepared statements and `batch`.

## Scope
1. **`migrations/0001_init.sql`:** tables `events`, `devices`, `photos` and `audit`, with every
   column, constraint (`UNIQUE(device_id, client_photo_id)`, foreign keys, `CHECK` on status
   enums) and index from DESIGN §6. Times are UTC ISO-8601 text. IDs are UUIDv7 or random
   (decide here and write it down).
2. **`src/worker/db/`:** one module per table, using prepared statements only. Include the
   atomic photo-limit insert (`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < photo_limit`
   with `ON CONFLICT(device_id, client_photo_id) DO NOTHING`, then re-select). Use row types
   rather than an ORM.
3. **`src/worker/domain/`:** pure functions with no I/O:
   - The event state machine: allowed `upload_status` and `gallery_status` transitions, and
     what "deleted" and "expired" mean. Expiry comes from `retention_until`, purge from
     `purge_after`.
   - ID and token generation: `public_id` (16 base32 characters), share token (≥128-bit),
     device credential (256-bit), enrolment code (8 base32 characters).
   - `hashToken()` (SHA-256 hex) and timing-safe comparison.
   - Cursor encoding for paginated lists (`published_at` + `id`).
4. **`src/shared/schemas.ts`:** zod schemas (strict, with size caps) for every request and
   response in DESIGN §8 and §9.1, plus the error shape and the closed set of error `code`s:
   `unauthorized`, `forbidden`, `not_found`, `event_closed`, `photo_limit`, `conflict`,
   `hash_mismatch`, `invalid_image`, `too_large`, `rate_limited`, `upload_expired`,
   `internal`. Types are inferred from the schemas.
5. **`contract/fixtures/*.json`:** one valid example per device-facing message, plus the
   enrolment request and response, the events list, the event detail with `galleryUrl`, the
   photo intent request, the intent responses (`ready`, `pending` with `upload`, and a
   `conflict` error), the upload responses (201, 202) and one of each error. Also gallery
   fixtures: the session exchange and the photos page. Name them
   `<area>.<message>.<variant>.json`.
6. **Tests:**
   - Vitest: migrations apply cleanly. DB functions round-trip. The photo-limit insert is
     atomic under 2 concurrent inserts at limit−1. The unique constraint makes a duplicate
     intent a no-op.
   - State transitions: allowed and forbidden.
   - Every fixture parses with its schema, and a mutated fixture with an unknown field fails.
7. **`scripts/seed.ts`:** deterministic local data (2 events — one OPEN/LIVE, one CLOSED —
   1 device, a few READY photos with placeholder variants) for `wrangler dev`. Document it in
   AGENTS.md.

## Out of scope
- HTTP routes (sessions 04–06, 11).
- Rust types (session 09 adds the serde structs and loads these fixtures).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test
bunx wrangler d1 migrations apply DB --local && bun run scripts/seed.ts   # then check rows in Local Explorer (/cdn-cgi/local/explorer)
```

## Done when
- [ ] The schema matches DESIGN §6 exactly, or DESIGN is updated with the reason.
- [ ] Every fixture is validated by zod in tests. The error-code set is final and listed in
      `wiki/Portal.md`.
- [ ] The photo-limit atomicity test passes.

## Hand-off
- `wiki/Portal.md`: the data model rationale (no admins table, share token stored retrievably,
  `access_version`), the ID scheme chosen, and how fixtures act as the cross-language contract.
- PROGRESS.md: **note that the booth track (08) may now start.**

