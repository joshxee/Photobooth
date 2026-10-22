# 12 — Gallery UI

**Goal:** the guest-facing gallery, which carries the product's market edge. Guests scan a
code, see their session's shots arrive live, browse the event, and save HD copies (2560 px)
on a phone, with a design that matches the booth's identity.

- **Depends on:** 11, and `wiki/portal/design/` populated by your Claude design session.
- **Unlocks:** 13.
- **Device check:** n/a (browser). Use `chrome-devtools-axi` with mobile emulation, plus one
  real-phone check during 13's once-over.
- **Human gate:** design sign-off on screenshots in the PR.

## Read first
- DESIGN.md §11 (all of it, including the polling rates and why), §2 (scope: single images,
  HD download, no ZIP), §16 and `spike/RESULTS.md` Q12 (event-day request budget).
- `wiki/portal/design/README.md` and everything in that folder. Its **grading criteria** are
  the acceptance rubric.
- `apps/booth/src/styles.css`, `apps/booth/src/fonts/` (identity), `wiki/Frontend.md`
  (testing conventions).
- `apps/portal/contract/fixtures/gallery.*`.

## Scope
1. **App shell** (`src/web/gallery/`):
   - React 19, no router library: one view plus a lightbox state stored in
     `history.state` so Back closes it.
   - The Geist fonts are copied into `src/web/ui/fonts/`, and the design tokens go in
     `src/web/ui/tokens.css`.
2. **Link handling:**
   - On load, read `#k` and `&s`, POST to `/api/session`, then `history.replaceState` to strip
     the fragment, keeping `?s=` for the session filter if present.
   - With no fragment, try the existing cookie.
   - On a 404, show the calm "This gallery isn't available" page (one page for every case).
3. **Grid:**
   - Lazy-loaded thumbnails (`loading="lazy"`, width and height from the API so nothing
     shifts).
   - Infinite scroll by cursor.
   - Session filter view: a "Your photos" header, placeholders for expected shots not yet
     READY (driven by polling), and a "See all event photos" action.
4. **Live updates:**
   - Poll every 30 s ± jitter only while `document.visibilityState === 'visible'` and
     `eventOpen`, plus one poll as soon as the page becomes visible again.
   - The session-filtered view polls every 10 s ± jitter for its first 2 minutes (while the
     guest's shots arrive), then drops to 30 s. Never poll faster: every poll is a request
     against the Workers Free daily limit (DESIGN §11, §16).
   - New photos collect into an "N new" pill; tapping it inserts them at the top without
     moving the current scroll position unexpectedly.
5. **Lightbox:**
   - Shows the `hd` variant, with swipe or arrow-key navigation, a Download button
     (`hd` with `?download=1`), Escape or Back to close, and focus trap and restore.
6. **Footer:** a short privacy notice, "Ask us to remove a photo", and the contact address and
   email (from the API).
7. **Accessibility:**
   - Keyboard-operable grid and lightbox, labelled controls, visible focus,
     `prefers-reduced-motion`, and AA contrast.
8. **Tests:** `bun test` + happy-dom: fragment stripping, polling start/stop on visibility,
   the 10 s → 30 s switch in the session view,
   "N new" merge without duplicates, lightbox keyboard handling and focus restore, the
   unavailable page, and the session filter with placeholders.

## Out of scope
- ZIP and bulk download, sharing integrations, strips, comments or likes, service worker or
  offline mode, analytics.

## Verify
```bash
cd apps/portal && bun run typecheck && bun run test && bun run build
bunx wrangler dev   # seed, open http://photos.localhost:8787/e/<publicId>#k=<token>&s=<session>
# chrome-devtools-axi: 375×812 emulation — screenshots of grid, session view with placeholders, lightbox, unavailable page;
#   keyboard-only pass; console has no errors; Lighthouse/perf: first grid < 2.5 s on throttled 10 Mbps
```

## Done when
- [ ] Every item in DESIGN §11 is implemented, and the screenshots are attached to the PR.
- [ ] The reviewer grades the screenshots against `design/README.md` criteria, with no
      `blocker`s.
- [ ] Keyboard-only and reduced-motion passes are recorded.
- [ ] Your design sign-off is recorded in PROGRESS.md.

## Hand-off
- `wiki/Portal.md` (gallery section): polling strategy and its request cost on Workers Free,
  the "N new" pattern, why
  there is no router or service worker, and the accessibility checks performed.
- PROGRESS.md entry.

