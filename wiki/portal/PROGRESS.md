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

## 01 — Spike — DONE — 2026-10-22
- PR: see the PR for branch `claude/01-spike-d33387` (app-created worktree branch, not `portal/01-…`, as in session 00)
- **Go/no-go (for the user to confirm): GO, with design change D14 (booth makes the variants).** Neither no-go trigger fired: integrity is enforced in-path (R2 `put` with `sha256` throws `10037` on a wrong hash or a truncated body, and stores nothing), and processing p95 is 3.9 s with the Images binding (p50 3.2 s, 17.5 MB input), under the 10 s trigger.
- **Recommendation (for the user to confirm): option B.** The booth makes thumb (480 px q75) and HD (2560 px long edge q85) in Rust with orientation applied and no metadata. The Worker only authenticates, does sha256 puts and walks the JPEG headers. Why: the real Images binding **keeps GPS and camera/lens serial numbers** whatever `metadata` is set to (local `wrangler dev` strips them, so a local test would pass); Images uses 355–470 ms CPU per photo, which **needs Workers Paid**, while option B uses ≈1 ms and runs on Free; and uploads drop from 11–17 MB to 0.3–0.6 MB per shot. Cost at 2,000 photos/month: **option B USD 0/month on Workers Free** (≈2.6 GB R2), option A ≈ USD 5–5.50. Workers plan: stay Free for staging and the pilot, and move production to Paid (USD 5) if the pilot's peak exceeds 50k requests/day (heavy event-day model ≈ 93k of the 100k limit).
- Built: `wiki/portal/spike/RESULTS.md` (Q1–Q12 with evidence); throwaway spike Worker `wiki/portal/spike/worker/` (not deployed again); scripts `jpeginfo.py` (stdlib APP1/TIFF inspector and retagger, with tests), `booth_variants.py`, `tailstats.py`, `run.ts`.
- Verified: on real Cloudflare (personal account, Workers Free): Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q11, and option B's put plus header check. Local `wrangler dev`: Q9. `python -I wiki/portal/spike/scripts/test_jpeginfo.py` (5 tests) and `bun run typecheck` in `spike/worker` pass. **NOT verified:** Q8 (the real Sony JPEG size: the fixtures are Canon EOS 80D/Photoshop files, not Sony, and the tablet had no capture in logcat); on-tablet encode time for option B (estimated 0.6–1.6 s per shot from a PC measurement); the Images pipeline on full-size inputs for Q5/Q6 (tested on a 2560 px copy, because full-size calls hit the Free CPU limit).
- Spike resources: Worker `portal-spike` and bucket `portal-spike` deleted (32 objects removed first), checked with `r2 bucket list` and a 404 from the URL. R2 stays enabled (empty) on the personal account.
- Device check: n/a (logcat read only)
- Deviations from DESIGN.md (v2.0 → v2.1, all in this PR): status line; §1 summary, data row, booth row and **cost row** (USD 0 on Free at 2,000 photos/month); §2 HD download instead of full resolution; **D4** (one signed URL per variant), **D5** (validation instead of processing in the request), **D6** (no `incoming/` prefix), new **D14** (booth makes variants, awaiting confirmation); §4 diagram (no Images binding); §5 (booth variant encoding plus a JPEG crate); §6 (`thumb_sha256`, `hd_sha256`, `thumb_stored`, `hd_stored`; `variant_bytes` is `{thumb, hd}`); **§7** (variants thumb + hd, measured sizes, immutable caching, metadata enforced by the booth and the server); §8 (PUT per variant); **§9.1–9.2** (per-variant flow, integrity confirmed, DigestStream fallback dropped); a note at §9.4 that **the file is truncated on main from there (§10–§18, including §13 and §16, missing)**. Its §13/§16 content from this spike is in RESULTS.md.
- Wiki updated: none (the results feed `wiki/Portal.md` in session 06, as planned)
- Notes for next session:
  - If the user confirms D14, these session files still describe the Images path and need updating before they run: 02 (bindings), 06 (upload + processing → upload + validation; intent cap; the header walk; error 10037 → 422), 07, 11/12 (`preview`/`full` → `hd`), 15, 16 (`incoming/` lifecycle), 17 (the metadata gate), 18, and SETUP A/B (Workers Paid and Images no longer required). The booth track (08/10) gains the variant encoder; measure it on the tablet there.
  - If the user rejects D14 (keeps option A): Workers Paid is required, the intent cap is 20,000,000 bytes, outputs must be buffered before `put`, and the Worker must strip APP1/APP13 from every Images output itself, because the binding doesn't.
  - Q8: on the first real capture (session 08), read `size` from the booth's `downloading the captured object` log line.
  - `bunx wrangler` silently does nothing on this PC unless Node is on PATH; use `fnm exec --using=22.11.0 -- node node_modules/wrangler/bin/wrangler.js`.
  - On Workers Free, measure CPU with `wrangler tail --format json` (`cpuTime`). Success rates mislead, because new deploys get a short CPU allowance.

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

