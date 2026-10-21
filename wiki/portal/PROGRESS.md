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

## 00 — Agent foundation — DONE — 2026-10-22
- PR: #14 (branch `claude/00-agent-foundation-a26fe3`, not `portal/00-…`: the session ran in an app-created worktree)
- Built: the plan itself is now in the repo at `wiki/portal/` (was untracked; `plans/portal` references rewritten to `wiki/portal`); `AGENTS.md` (single source, ~100 lines; the device-testing section from the old CLAUDE.md is kept); `CLAUDE.md` is a pointer; `README.md` fixed; `.mcp.json` (Cloudflare Docs + API MCP); `.gitignore` entries; `wiki/README.md` "Portal (in progress)" index.
- Verified: the stale-term grep over AGENTS.md/CLAUDE.md/README.md has no hits; `cargo test -p photobooth-core` and `bun install --frozen-lockfile && bun run typecheck` in `apps/booth` run as written. The full CI command list in AGENTS.md was copied from `ci.yml`, not re-run. The `.mcp.json` servers and the Cloudflare plugin install were NOT exercised (no Cloudflare account or token used).
- Device check: n/a
- Deviations from DESIGN.md: none
- Wiki updated: `wiki/README.md`
- Not done: enabling the Cloudflare Skills plugin in `.claude/settings.json` (optional in the plan; the agent harness blocked edits to that file). Add `"cloudflare@cloudflare": true` to `enabledPlugins` and `extraKnownMarketplaces.cloudflare = {"source": {"source": "github", "repo": "cloudflare/skills"}}`, or run the two `/plugin` commands in AGENTS.md. The marketplace and plugin names were checked against the `cloudflare/skills` repo.
- Notes for next session: `apps/portal` does not exist yet, so the portal commands in AGENTS.md are described, not runnable. The crate-level `Cargo.lock` ignore entries match nothing tracked. AGENTS.md says photos are in memory only except the portal outbox (per README hard constraints); the root README still says "never written to disk", update it in session 08.

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

