# Design starter

Put the output of the Claude design session here before session 12 starts:

- `gallery.*`: the gallery grid, the session-filtered view with "processing" placeholders, the
  lightbox, the empty and expired states, and the footer.
- `post-shoot.*`: the booth's post-shoot screen with the session QR code and the new copy.
- `tokens.md`: colours, type scale and spacing. Start from the booth's Geist fonts and the
  tokens in `apps/booth/src/styles.css` so both apps feel related.

Use static HTML or JSX mock-ups, screenshots, or both. The implementing session treats them as
the target and the criteria below as the grading rubric (session 12 and 13 reviewers use it).

## Grading criteria

1. **Feels like a whole:** colour, type and spacing read as one coherent identity shared with
   the booth, not a template.
2. **Guest-first on a phone:** a guest can find their shots and save one within 10 seconds of
   scanning, one-handed, on a 375 px screen.
3. **Live feels live:** new photos arrive smoothly ("N new" pill, no layout jump), and
   placeholders are honest about processing.
4. **Craft:** typography hierarchy, consistent spacing, WCAG 2.2 AA contrast, visible focus,
   reduced-motion respected.
5. **Calm failure:** expired, suspended or invalid links get a friendly page that doesn't leak
   which case applies.

