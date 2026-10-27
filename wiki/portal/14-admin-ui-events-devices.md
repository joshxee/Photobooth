# 14 — Admin UI: events, event QR and devices

**Goal:** the two admins can run an event from the browser: create it, open and close uploads,
publish it, print the event-wide QR code, and enrol, monitor and revoke booths.

- **Depends on:** 05, 11.
- **Unlocks:** 15.
- **Device check:** n/a (browser, `chrome-devtools-axi`).

## Read first
- DESIGN.md §12 (events, event QR, devices), §15 (event-day runbook: what admins need to see).
- `wiki/Portal.md`. The admin routes from 04 and 05 (zod schemas in `src/shared/schemas.ts`).
- `src/web/ui/` tokens from 12. Reuse them, but the admin UI is plain and functional; it needs
  no design pass.

## Scope
1. **Admin shell** (`src/web/admin/`):
   - About 5 views over a small `history` wrapper (no router library): Events list, Event
     detail, Devices, Audit (placeholder for 15), and Not authorised.
   - A `fetch` wrapper that sends JSON and parses error codes into readable messages.
2. **Events:**
   - List with status chips and counts.
   - Create and edit form (name, venue, IANA timezone picker, start and end in local time,
     converted to UTC).
   - Actions: open, close, publish, suspend, rotate link, delete, restore. Destructive actions
     need confirmation. The rotate confirmation warns that printed signage must be reprinted.
   - Close-uploads warning: show each device's backlog from the devices API, and warn if any
     booth on this event has queued items.
3. **Event QR:**
   - Generate it in the browser with **one small dependency-free QR library** (justify the
     choice in the PR).
   - Show it on screen, and offer SVG download (print) and PNG download (canvas), plus copy
     link.
   - The URL is the whole-event gallery link with no session filter.
4. **Devices:**
   - List with name, enrolled, last seen (relative), backlog, app version and revoked.
   - Create device, which shows the code once with a 10-minute countdown and is never stored
     in the UI state after closing.
   - Re-issue the code. Revoke with confirmation.
   - Auto-refresh every 15 s while the view is visible (the event-day health view).
5. **Tests** (`bun test` + happy-dom): forms (timezone conversion), confirmations,
   enrolment-code display lifecycle, QR output matching the URL (round-trip through a decoder
   in a test, or snapshot the module's matrix), error message mapping.

## Out of scope
- The photo grid and moderation, the audit list (15). Bulk operations. User management
  (Access does that).

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test && bun run build
bunx wrangler dev --var DEV_AUTH:1   # chrome-devtools-axi on http://admin.localhost:8787 : full event lifecycle, enrol device via code, QR downloads; keyboard pass
# staging (after merge to main / workflow_dispatch): same lifecycle through Access in a real browser (you or agent with service token where UI allows)
```

## Done when
- [x] The full event lifecycle and device enrolment can be done in the UI alone, without curl.
      (Run in real Chrome against local `wrangler dev`; the booth side of enrolment was not run,
      the code is created and re-issued in the UI.)
- [x] The event QR scans to the right gallery (decoded in a test; **not** scanned with a phone).
- [x] The rotate warning and the close-uploads backlog warning are both present.

## Hand-off
- `wiki/Portal.md` (admin section): what the event-day health view shows and why, QR library
  choice, why there is no router.
- PROGRESS.md entry.

