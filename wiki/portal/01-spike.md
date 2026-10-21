# 01 — Spike: prove the risky assumptions

> **Done 2026-10-22 (GO with D14, confirmed by the user).** This file is the spike's original brief and
> still describes the Images-binding design it tested (`preview`, `full`, `incoming/`). The results are in
> [spike/RESULTS.md](./spike/RESULTS.md), and DESIGN.md (v2.1 as revised by PR #17) is the current design.

**Goal:** a go/no-go, with numbers, for the parts of DESIGN.md that rely on platform behaviour
not yet verified. The code is throwaway. **The deliverable is `spike/RESULTS.md`** plus any
DESIGN.md corrections.

- **Depends on:** 00, SETUP A (personal account, sample JPEGs in
  `wiki/portal/spike/fixtures/`).
- **Unlocks:** 02.
- **Device check:** n/a.
- **Human gate:** you read RESULTS.md and record go/no-go in PROGRESS.md.

## Read first
- DESIGN.md §7 (variants), §9 (upload flow, §9.2 integrity, §9.4 limits), §13 (image limits),
  §16 (cost).
- Cloudflare docs, as markdown:
  - `https://developers.cloudflare.com/r2/api/workers/workers-api-reference/index.md`
    (`put` options, `sha256`)
  - `https://developers.cloudflare.com/images/transform-images/bindings/index.md`
  - `https://developers.cloudflare.com/workers/platform/limits/index.md`

## Scope
A minimal Worker in `wiki/portal/spike/worker/` (its own `package.json` and `wrangler.jsonc`,
deployed to the **personal** account as `portal-spike`) with:
1. `PUT /put?sha256=<hex>`: stream the body to R2 with the `sha256` option.
   - **Q1:** does a wrong hash make `put` throw, and with what error?
   - **Q2:** does it work with `request.body` and a known `Content-Length`, without buffering?
     If `sha256` does not verify, measure the `crypto.DigestStream` fallback.
2. `POST /process/<key>`: read from R2, call `Images.info`, then produce thumb, preview and full
   variants (DESIGN §7) with `metadata: none`, writing each back to R2.
   - **Q3:** do 20 MB and 24 MP Sony JPEGs pass the binding's input limits? Record the exact
     limits found.
   - **Q4:** wall time for `info` plus three transforms plus puts (p50 and p95 over 20 runs).
   - **Q5:** is EXIF orientation applied before stripping? Use a fixture with a rotated
     orientation tag.
   - **Q6:** do GPS and serial-number EXIF survive in any variant? Use `exiftool` if available;
     otherwise parse the APP1 segment in a small script.
   - **Q7:** output sizes per variant, to check the 5.7 MB/photo storage assumption in §16.
3. **Q8:** the real JPEG size the booth receives over PTP. Use the SD-card fixtures' sizes. If
   the booth logs transfer sizes (`logs_recent`), compare them; otherwise note it as unverified
   and carry it to session 08.
4. **Q9:** a local `wrangler dev` check — does the local Images binding simulation support
   `info`, `transform` and `output`? This decides how much session 06 can test locally.

Record each answer in `wiki/portal/spike/RESULTS.md` as a table: question, result, evidence
(command and output), and the DESIGN impact.

## Out of scope
- Anything production-shaped (auth, D1, error contracts).
- Committing photos (fixtures are git-ignored).

## Clean-up (do it, then note it in RESULTS.md)
```bash
bunx wrangler delete portal-spike
bunx wrangler r2 object delete …   # each spike object, then:
bunx wrangler r2 bucket delete portal-spike
```
Keep the spike source in `wiki/portal/spike/worker/` for reference. It is not deployed again.

## Done when
- [ ] All of Q1–Q9 are answered with evidence, or explicitly marked "could not verify" with the
      reason.
- [ ] DESIGN.md is updated where the results change it (limits, fallback hashing, variant
      settings, cost). Each change is listed in PROGRESS.md.
- [ ] Spike resources are deleted from the personal account.
- [ ] Go/no-go recorded. No-go triggers: integrity cannot be enforced in-path, or p95
      processing is over 10 s. Either one means revisiting DESIGN §9.4 (async processing)
      before session 06.

## Hand-off
- PROGRESS.md entry (with the go/no-go line for the user to confirm).
- No wiki page yet; the results feed `wiki/Portal.md` in session 06.

