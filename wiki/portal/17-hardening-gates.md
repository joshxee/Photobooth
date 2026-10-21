# 17 — Hardening and release gates (critical)

**Goal:** prove the system against DESIGN §13 and the six release gates in §17 on staging,
with evidence, and close whatever gaps that exposes. Fixes stay small; anything big becomes
its own session (`17b-*.md`).

- **Depends on:** 00–16 merged and staging green.
- **Unlocks:** 18.
- **Device check:** **critical**. You run gates 2 and 6 with the agent.

## Read first
- DESIGN.md §13 (whole table), §14, §15, §17 (release gates).
- `wiki/Portal.md`, `wiki/Booth-Upload.md`, and PROGRESS.md (collect every "not verified"
  note from earlier sessions; this session either verifies each one or lists it as an accepted
  risk).

## Scope
1. **Security sweep** (one test or one documented manual check per DESIGN §13 row), saved as
   `apps/portal/test/security/*.test.ts` plus `wiki/portal/gates/security.md`:
   - Access: spoofed JWT, wrong `aud`, expired, `alg:none`, the email header alone, and the
     `workers.dev` and preview URLs on staging.
   - Cross-event and hidden-photo access.
   - Revoked device with an issued upload URL.
   - Enrolment-code brute force hitting the rate limit.
   - Oversized, truncated and fake JPEGs.
   - CSP and headers on every response type (HTML, JSON, media, error), via `curl -I` against
     staging.
   - **Logs:** tail staging during a smoke run and grep for tokens, cookies, `sig=` and
     `#k=`. There must be none.
   - Dependency audit: `bun pm ls`, and check each portal dependency is in DESIGN §5.
2. **Release gates** (record each in `wiki/portal/gates/release.md` with evidence):
   1. Security (above).
   2. **Durability on device** (critical): 50 shots across about 17 sessions, with 30 minutes
      of airplane mode plus one app kill. The result must be exactly 50 READY, no duplicates,
      correct event IDs, and an empty outbox. The agent automates it and you watch and confirm.
   3. Media sanitisation: real Images on staging, using the GPS fixture and a real Sony JPEG.
      No metadata in any variant, and orientation correct.
   4. Deletion during uploads: delete the event while a booth drains, check there is no late
      READY, restore within 7 days, then purge on schedule (cron run manually on staging).
   5. **Load:** a `scripts/load.ts` simulating 5 devices at about 0.5 photos/s total for
      10 minutes against staging. Shot-to-READY p95 must be under 15 s, with no 5xx. Gallery
      first grid under 2.5 s at 10 Mbps (`chrome-devtools-axi` throttling).
   6. **Accessibility** (critical: you do a short screen-reader pass): keyboard and
      screen-reader on the gallery and admin; WCAG 2.2 AA checks recorded.
3. **Operations:**
   - Write `wiki/portal/gates/runbook.md`: the event-day checklist from DESIGN §15, the
     restore procedure, rotation, revocation, the removal request, and "booth shows backlog".
   - Confirm the billing alerts exist (SETUP B).
   - Confirm `CONTACT_*` values are set for production (SETUP F).
4. **Gap fixes:** small and in this PR. Anything over about half a day becomes `17b-*.md` and
   must merge before 18.

## Out of scope
- New features. Paging or alerting infrastructure (DESIGN §15: none in MVP).

## Verify
All the gate evidence files are complete. `bun run test` includes the security tests.
`scripts/load.ts` results are attached.

## Done when
- [ ] Every DESIGN §13 row and every §17 gate is marked pass with evidence, or recorded as an
      accepted risk that you sign off in PROGRESS.md.
- [ ] Every earlier "not verified" note is resolved or accepted.
- [ ] The runbook is written. You have ticked the critical gates (2, 6).

## Hand-off
- `wiki/Portal.md` and `wiki/Booth-Upload.md`: final "verified / not verified" sections, the
  load numbers, and the accepted risks.
- PROGRESS.md entry.

