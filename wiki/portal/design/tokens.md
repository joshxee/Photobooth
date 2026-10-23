# Design tokens

Taken from the user's claude.ai Design canvas "Photobooth Guest Portal" (exported 2026-10-23,
canvas version 1792720292-bf54), with the booth's values from `apps/booth/src/styles.css` beside
them. Decisions recorded with the user on 2026-10-15: neutral palette, primary buttons near-black
(not blue), Figtree on the canvas. Contrast ratios are computed (WCAG 2.x relative luminance).

## Colour

| Token | Canvas | Booth (`styles.css`) | Use | Contrast |
|---|---|---|---|---|
| `--bg` | `#FFFFFF` | `--paper #fcfaf6` | Page background (light screens) | |
| `--surface` | `#F6F7F5` | `--paper-2 #f6f2ec` | Quick-check box, "See everyone's photos" card | |
| `--surface-2` | `#F1F2F4` | | Share-target circles | |
| `--ink` | `#17181A` | `--ink #1b1f22` | Text, primary button fill, "N new" pill | 17.8:1 on `--bg` |
| `--ink-2` | `#5C6066` | `--ink-2 #4a4f54` | Secondary text, timestamps, meta, chevrons | 6.3:1 on `--bg`, 5.9:1 on `--surface` |
| `--hairline` | `#D9DCE0` | `--hairline #dcd8d0` | Secondary button and quick-check borders, sheet handle | decorative |
| `--hairline-2` | `#ECEDEF` | | Desktop header and footer rules | decorative |
| `--brand` | `#2C5B3F` | `--forest #2e5240` | knockbox mark, "knockbox.nz" link | 7.9:1 on `--bg` |
| `--live` | `#1F7A4D` | | "Live" dot, quick-check tick | dot is decorative; the word "Live" carries the meaning |
| `--disabled-bg` / `--disabled-ink` | `#E4E6E9` / `#6B7078` | | Disabled primary button | exempt (inactive control) |
| `--dark-bg` | `#0B0B0C` | `--ink #1b1f22` (booth body) | Viewer and booth post-shoot background | |
| `--dark-surface` | `#1C1D20` | | Secondary button on dark | |
| `--dark-line` | `#3A3D42` | | Secondary button border on dark | |
| `--dark-ink-2` | `#B3B7BD` | | Secondary text on dark | 9.8:1 on `--dark-bg` |
| `--dark-dot` | `#5C6066` | | Inactive position dot on dark | 3.1:1 on `--dark-bg` (non-text 3:1) |
| photo tones | `#C9D3CF #D9CBBE #B7C4D6 #A9B5A2 #CDB9C7 #E2D6C2 #8F9AA8 #C4CBB8 #D6C3B4 #B9C2C9 #DCCFD6 #A7B0BC` | | Flat placeholders on the canvas for photos | |

The canvas sets a default link colour `#1F5BD8` (hover `#1748AE`) in every artboard but uses it
nowhere visible: all visible links are `--ink` or `--brand`.

## Type

Canvas font: **Figtree** 400/500/600/700/800 (Google Fonts). Booth: **Geist** 400/500/600 and Geist
Mono (TTF files in `apps/booth/src/fonts/`). Which one the gallery uses is a decision for session 12
(see README.md).

| Role | Size / line height | Weight | Tracking | Where |
|---|---|---|---|---|
| Display (arrive) | 32 / 1.1 | 700 | -0.02em | Event name on the arrive screen |
| Title (session) | 28 / 1.15 | 700 | -0.02em | "Session #24" on the session view |
| Title (gallery header) | 22 (desktop 24) | 700 | -0.01em | Event name above the grid |
| Section heading | 17 (desktop 19) | 700 | -0.01em | "Session #N" group headings, a 44 px tall link |
| Sheet heading | 18 | 700 | | "Share photo" |
| Button | 17 (viewer 16, sheet 15) | 600 | | Primary and secondary buttons |
| Body | 16 / 15 | 500 / 400 | | Quick-check label, session meta line |
| Small | 14 / 13 | 600 / 400 | | Pill, "Live · N photos", footer |
| Eyebrow | 13 | 600, uppercase | 0.08em | "[Date] · [Venue]", event name above the session title |
| Meta | 12 | 400, tabular numerals | | "9:42 PM · 4" beside section headings, viewer position |
| Wordmark | 17–18 | 800 | -0.03em | "knockbox" beside the mark |
| Booth post-shoot | 56 / 1.05 headline, 22 / 1.4 body, 18 controls | 700 / 400 / 600 | -0.02em headline | Tablet screen (13) |

## Spacing, size and shape

- Page gutter: 20 px on phone (arrive sheet 24 px), 40 px on desktop (content max-width 1360 px).
- Grid gaps: 2 px in the 3-column phone grid, 4 px desktop (`auto-fill, minmax(180px, 1fr)`),
  6 px in the 2-column session view, 12 px between paired buttons, 3 px in the arrive mosaic.
- Vertical rhythm: 4 px between session groups on phone, 24 px on desktop; header padding
  18/12 px; sheet padding 32/24/28 px with 28 px gaps.
- Touch targets: every control is at least 44 × 44 px (icon links 44, buttons 56, pill 44,
  quick check 64).
- Radii: buttons are pills (`height / 2`: 28 for 56, 26 for 52, 22 for 44); cards and quick check
  16 px; session-view photos 12 px; desktop photos 4 px; phone grid photos square (0); bottom
  sheets 24 px top corners; QR card 24 px.
- Tiles: phone grid tiles are square crops; one "hero" tile per some sessions spans 2 × 2
  (desktop: 2 columns). Session-view and desktop tiles are 2:3 portrait.
- Elevation: only the "N new" pill, `0 6px 20px rgba(0,0,0,0.18)`.
- Icons: inline 24-grid stroke icons, 2 px stroke (2.5 on the pill arrow, 3 on the tick), round
  caps and joins.
