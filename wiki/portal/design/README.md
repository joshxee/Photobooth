# Design starter

The output of the user's Claude design session, the target for sessions 12 (gallery) and 13
(booth post-shoot screen):

- `gallery.html`: the guest gallery artboards as static HTML. 1 · Arrive + quick check,
  2 · Event gallery (live, grouped by session, the "N new" pill), 3 · Photo viewer (dark, with
  the share sheet open), 4 · Your session (the booth QR's landing view), and the desktop gallery
  with its footer.
- `post-shoot.html`: the booth's post-shoot screen with the session QR code and the new copy.
- `tokens.md`: colours, type scale and spacing, beside the booth's values from
  `apps/booth/src/styles.css`.

**Source:** the claude.ai Design canvas "Photobooth Guest Portal" (private to the owner),
exported on 2026-10-23 from canvas version 1792720292-bf54. The canvas's template loops are
resolved to static markup with the values unchanged; photos are flat colour placeholders.
Decisions recorded with the user on 2026-10-15: no account, a quick human check, no "Mine"
button, near-black `#17181A` primary buttons (not blue), Figtree, a neutral palette. Open then:
whether the viewer stays dark.

## Not on the canvas

Session 12 derives these from the canvas's language (tokens, type, components), and the PR
screenshots are what the user signs off:

- the processing placeholders in the session view (shots expected but not READY yet),
- the empty gallery (LIVE, no photos yet),
- the "This gallery isn't available" page (one page for every refusal),
- the phone footer with the privacy notice, "Ask us to remove a photo", and the contact
  address and email (DESIGN §11). The canvas has a footer only on desktop, without the notice.

## Where the canvas and the plan differ

Listed for the user's decision before session 12 builds (the answers are recorded in
PROGRESS.md under session 12):

- **Font:** Figtree (canvas) or the booth's Geist (DESIGN §5, the session file). The CSP is
  `default-src 'self'`, so either font is self-hosted, never loaded from Google Fonts.
- **Quick human check** on the arrive screen: DESIGN §11 specifies none; a real one (Turnstile)
  adds a dependency, a third-party script the CSP would have to allow, and requests.
- **The arrive screen itself:** DESIGN §11 opens the gallery straight from the link.
- **"Photos are kept for [N] days"** on the arrive screen contradicts D15 (no expiry).
- **"Live · 128 photos"** and "128 so far": the gallery API returns no total.
- **"Session #24":** the booth's session ID is `{boot nonce}-{n}`, so no stable session number
  exists per event.
- **"[Venue]":** the gallery API returns the event name and local date only.
- **Share** (viewer and session view) with named targets and "Copy link": sharing integrations
  are out of scope (session 12), and copying the link would hand out the event's access.
- **"Save all 4":** DESIGN §2 rules out ZIP and bulk download.
- **The dark viewer:** open since 2026-10-15.

## Grading criteria

1. **Feels like a whole:** colour, type and spacing read as one coherent identity shared with
   the booth, not a template.
2. **Guest-first on a phone:** a guest can find their shots and save one within 10 seconds of
   scanning, one-handed, on a 375 px screen.
3. **Live feels live:** new photos arrive smoothly ("N new" pill, no layout jump), and
   placeholders are honest about processing.
4. **Craft:** typography hierarchy, consistent spacing, WCAG 2.2 AA contrast, visible focus,
   reduced-motion respected.
5. **Calm failure:** suspended, deleted or invalid links get a friendly page that doesn't leak
   which case applies.
