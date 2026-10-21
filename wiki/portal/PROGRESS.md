# Progress log

Newest entry first. Every session adds one entry before opening its PR. The next session reads
this file first, so state facts and not intentions.

## Template

```markdown
## NN — <session name> — DONE | PARTIAL | BLOCKED — YYYY-MM-DD
- PR: #<n> (branch portal/NN-…)
- Built: <what exists now, 1–4 bullets>
- Verified: <commands run; what was exercised against real Cloudflare / tablet; what was NOT>
- Device check: n/a | automated: <evidence> | critical: awaiting once-over / ticked by <name> on <date>
- Deviations from DESIGN.md: <none | what changed and why, and the DESIGN section updated>
- Wiki updated: <pages>
- Remaining (PARTIAL/BLOCKED only): <exact next steps>
- Notes for next session: <gotchas, decisions a later session needs>
```

---

## Plan created — 2026-10-21
- Design accepted (DESIGN.md v2.0). Sessions 00–18 written.
- Decisions agreed with the user:
  - Test the Worker with the Cloudflare Vitest plugin.
  - Use staging only, no Workers Previews.
  - Agents never deploy production or hold a Cloudflare write token.
  - One-time setup is a manual checklist.
  - Critical device flows get a human once-over.
  - Use the booth's look plus a Claude design starter for the gallery.
- Next: session 00.

