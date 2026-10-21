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

## 01b — Plan aligned with D14 — DONE — 2026-10-22
- PR: #18 (branch `claude/01b-d14-plan-9ce9e5`, app-created worktree branch). Docs only, no code.
- **The user gave the spike's GO and confirmed D14 on 2026-10-22**: the booth makes the variants in Rust (thumb 480 px q75, HD 2560 px q85, orientation applied, no metadata); there is no Images binding; the Worker only authenticates, does sha256 R2 puts and walks the JPEG headers; Workers Free. Budget USD 20/month; 4 events × 500 photos a month; R2 stores only the booth-made variants (no originals), and the SD card keeps the originals.
- Built: DESIGN.md **v2.2**, merged on top of PR #17 (which had already aligned the restored §9.3–§19 with D14). #17's decisions are kept: baseline-only header walk (no APP2, final EOI), 30 s polling with a 10 s session-view burst, the RESULTS Q12 request model (≈ 36k typical, ≈ 96k heavy), ≈ USD 1.50 all-in on Free, 17–24 days. On top of #17: D14 marked confirmed; §9 renamed "Upload and validation"; §9.1/§9.3 define the REJECTED intent and PUT; §9.4 rewritten (no in-request processing; `acceptVariant()` replaces `processPhoto()`); §10 has the encoder as its own item (bytes handed to the hook, because `PhotoStore` is cleared on return to attract; **encode gate 3 s per shot at p95**, derived from the 15 s shot-to-READY budget); §11 variants and caching note; §12 admin proxy; §13 metadata row and daily-limit flood row; §14 retention rows; §15 Workers Free limits (shared per account, fail closed, 10 ms CPU incl. cron, logs 3-day retention until 2026-12-01); §16 full event-day table and the triggers for moving the account to Workers Paid; §17 testing seams and gate 3 on both the booth encoder and the Worker; §18 "changed from v2.0 by D14" table; §19, §20.
- Session files: **new `08b-booth-variant-encoder.md`**; 06 rewritten and renamed `06-upload-validation.md`; 02, 03, 07, 08, 09, 10, 11, 12, 13, 15, 16, 17, 18 and SETUP A/B/C updated; 01-spike.md marked historical; README graph, table and cross-cutting rules updated.
- Why 08b owns the encoder: it is pure Rust in `photobooth-core`, like the outbox, so it belongs in the booth core and not in 10, which is already the critical device session. It runs before 09/10 so D14's open risk (encode time on the tablet, plus the Sony size, Q8) is measured before anything builds on it. 08 plus the encoder would not fit one context window, so it is a separate `NNb` file. 08 defines the `EncodedShot` type, and 10 now depends on 08b.
- Verified: `git grep -n -i -E "images binding|IMAGES|preview|full\.jpg|incoming/|workers paid" wiki/portal` leaves only intended hits: history (01-spike.md, RESULTS.md, the spike Worker, the 01 entry), D14's own reasoning, Workers Previews/`preview_urls` (unrelated), and the conditions for moving to Workers Paid. A fresh-context review found the branch predated #17, plus 4 should-fix and 8 nit findings; all are fixed in this PR. Workers Free limits were checked against the Cloudflare docs on 2026-10-22. Nothing was run against Cloudflare or the tablet.
- Device check: n/a
- Deviations from DESIGN.md: this PR is the DESIGN change (v2.1 → v2.2). New choices the user may want to revisit: the 3 s/shot encode gate (08b); one zone WAF rate-limiting rule against floods (SETUP C).
- Wiki updated: none outside `wiki/portal/` (sessions update `wiki/Portal.md` and `wiki/Booth-Upload.md` as they land)
- Notes for next session: 02 may start. The booth track after 03 is 08 → 08b → 09 → 10. The intent contract is per variant (`variants.thumb`/`variants.hd` in, `uploads.<variant>` out, PUT `/v1/device/uploads/{photoId}/{variant}`, 200 STORED / 201 READY, REJECTED state on re-intent); 03's fixtures must cover it.

---

## 01 — Spike — DONE — 2026-10-22
- PR: #15 (branch `claude/01-spike-d33387`; app-created worktree branch, not `portal/01-…`, as in session 00), merged before the review findings were fixed; those fixes are in the follow-up PR from `claude/01-spike-review-fixes`
- **Go/no-go: GO, with design change D14 (booth makes the variants). Confirmed by the user on 2026-10-22.** Neither no-go trigger fired: integrity is enforced in-path (R2 `put` with `sha256` throws `10037` on a wrong hash or a truncated body, and stores nothing), and processing p95 is 3.9 s with the Images binding (p50 3.2 s, 17.5 MB input), under the 10 s trigger.
- **Recommendation: option B (confirmed by the user on 2026-10-22 as D14).** The booth makes thumb (480 px q75) and HD (2560 px long edge q85) in Rust with orientation applied and no metadata. The Worker only authenticates, does sha256 puts and walks the JPEG headers. Why: the real Images binding **keeps GPS and camera/lens serial numbers** whatever `metadata` is set to (local `wrangler dev` strips them, so a local test would pass); Images uses 355–470 ms CPU per photo, which **needs Workers Paid**, while option B uses ≈1 ms and runs on Free; and uploads drop from 11–17 MB to 0.25–0.62 MB per shot. Cost at 2,000 photos/month: **option B USD 0/month of Cloudflare usage on Workers Free** (≈2.6 GB R2; ≈ USD 1.50 all-in with the domain), option A ≈ USD 5–5.50. Workers plan: stay Free for staging and the pilot, and move the account to Paid (USD 5) if the pilot's account-wide peak exceeds 50k requests/day (heavy event-day model ≈ 96k of the 100k limit, which staging shares). This needs guest polling at 30 s (DESIGN §11 had 5 s) and immutable media caching, both now in DESIGN.
- Built: `wiki/portal/spike/RESULTS.md` (Q1–Q12 with evidence); throwaway spike Worker `wiki/portal/spike/worker/` (not deployed again); scripts `jpeginfo.py` (stdlib APP1/TIFF inspector and retagger, with tests), `booth_variants.py`, `tailstats.py`, `run.ts`.
- Verified: on real Cloudflare (personal account, Workers Free): Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q11, and option B's put plus header check. Local `wrangler dev`: Q9. `python -I wiki/portal/spike/scripts/test_jpeginfo.py` (5 tests) and `bun run typecheck` in `spike/worker` pass. **NOT verified:** Q8 (the real Sony JPEG size: the fixtures are Canon EOS 80D/Photoshop files, not Sony, and the tablet had no capture in logcat); on-tablet encode time for option B (estimated 0.6–1.6 s per shot from a PC measurement); the Images pipeline on full-size inputs for Q5/Q6 (tested on a 2560 px copy, because full-size calls hit the Free CPU limit).
- Spike resources: Worker `portal-spike` and bucket `portal-spike` deleted (32 objects removed first), checked with `r2 bucket list` and a 404 from the URL. R2 stays enabled (empty) on the personal account.
- Device check: n/a (logcat read only)
- Deviations from DESIGN.md (v2.0 → v2.1, all in this PR): status line; §1 summary, data row, booth row and **cost row** (USD 0 on Free at 2,000 photos/month); §2 HD download instead of full resolution; **D4** (one signed URL per variant), **D5** (validation instead of processing in the request), **D6** (no `incoming/` prefix), new **D14** (booth makes variants; awaiting confirmation at the time, confirmed 2026-10-22, see 01b); §4 diagram (no Images binding); §5 (booth variant encoding plus a JPEG crate); §6 (`thumb_sha256`, `hd_sha256`, `thumb_stored`, `hd_stored`; `variant_bytes` is `{thumb, hd}`); **§7** (variants thumb + hd, measured sizes, immutable caching, metadata enforced by the booth and the server); §8 (PUT per variant); **§9.1–9.2** (per-variant flow, integrity confirmed, DigestStream fallback dropped); and (follow-up PR, after #16 restored §9.4–§20) §9.3 `200 STORED` row and 202 semantics, §9.4 note, §10 outbox stores the two variants, **§11 polling 5 s → 30 s and media `immutable` caching**, **§13** malicious-image row (no re-encode; header walk tightened to baseline-only, no APP2, final EOI), §14 (no incoming objects), **§16 cost rewritten** (≈ USD 1.50 all-in on Free), §17 tests and gate 3, §18, §19 effort 17–24 days.
- Wiki updated: none (the results feed `wiki/Portal.md` in session 06, as planned)
- Notes for next session:
  - D14 is confirmed; 01b updated these session files before they run (this note is kept for history): each session must not start from its own stale text. They still describe the Images path: 02 (bindings), 06 (upload + processing → upload + validation; intent cap; the header walk; error 10037 → 422), 07, 11/12 (`preview`/`full` → `hd`), 15, 16 (`incoming/` lifecycle), 17 (the metadata gate), 18, and SETUP A/B (Workers Paid and Images no longer required). The booth track gains the variant encoder (now session 08b), measured on the tablet there.
  - (No longer applies: D14 is confirmed.) If D14 were ever reversed (option A): Workers Paid is required, the intent cap is 20,000,000 bytes, outputs must be buffered before `put`, and the Worker must strip APP1/APP13 from every Images output itself, because the binding doesn't.
  - Q8: on the first real capture (now session 08b), read `size` from the booth's `downloading the captured object` log line.
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

