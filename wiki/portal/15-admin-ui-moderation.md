# 15 — Admin moderation, media proxy and audit view

**Goal:** admins can see every photo in an event by state, hide and unhide photos, permanently
delete one for a removal request, and read the audit log.

- **Depends on:** 14.
- **Unlocks:** 17.
- **Device check:** n/a (browser).

## Read first
- DESIGN.md §8 (admin photos list), §12 (photos, audit), §14 (removal requests).
- `wiki/Portal.md`. Session 11's media route (reuse its streaming helper).

## Scope
1. **API** (admin host):
   - `GET /api/events/{id}/photos?state&hidden&cursor`.
   - `POST /api/photos/{id}/hide` and `/unhide`.
   - `DELETE /api/photos/{id}`: delete both variant objects (`thumb.jpg`, `hd.jpg`; either may
     be missing for a PENDING or REJECTED photo), then delete the row, or mark it deleted if
     the audit needs the ID. Confirm and record the choice.
   - `GET /api/media/{photoId}/{variant}`: admin media proxy for `thumb` or `hd` in any state,
     with `Cache-Control: private, no-store`.
   - `GET /api/audit?event&cursor`.
   - All mutations are audited, and tests confirm hide and delete take effect for guests
     immediately.
2. **UI:**
   - Event detail gets a Photos tab: a grid filtered by state (pending, ready, rejected, with
     the reject reason) and hidden.
   - A lightbox showing `hd`, with Hide, Unhide and "Delete permanently". The delete
     confirmation names the consequence (removed from guests and storage now; guests who
     already opened it may still have it in their browser cache; erase the SD-card file too).
   - An Audit view: a filterable list of actor, action, target and time.
3. **Tests:**
   - Vitest: the API paths. After hide or delete, guest list and media return 404. Objects are
     gone from R2. Audit rows are written.
   - `bun test`: UI flows.

## Out of scope
- Bulk moderation, automatic moderation, CSV exports.

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test && bun run build
# local with DEV_AUTH + seed: hide → guest view loses it on next poll; delete → R2 objects gone (Local Explorer)
```

## Done when
- [ ] The removal-request flow works end to end, and the R2 objects are verified gone.
- [ ] Hidden photos are never visible or fetchable by guests (tested).
- [ ] The audit list shows every admin action from sessions 04, 05 and 15.

## Hand-off
- `wiki/Portal.md`: why single-photo deletion is immediate when event deletion has a 7-day
  undo, and the removal-request runbook (portal plus SD card).
- PROGRESS.md entry.

