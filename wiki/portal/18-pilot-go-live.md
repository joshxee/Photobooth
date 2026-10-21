# 18 — Production go-live and pilot event (critical)

**Goal:** production is deployed by you through the approval gate, a real low-volume NZ event
runs on it, and the counts reconcile. After this the MVP is live.

- **Depends on:** 17 (all gates pass or are accepted), SETUP F.
- **Unlocks:** —
- **Device check:** **critical** (a real event).
- **Human gate:** you approve the production deploy and run the event. The agent prepares,
  watches the read-only logs, and reconciles.

## Read first
- `wiki/portal/gates/runbook.md`, `wiki/portal/gates/release.md`.
- DESIGN.md §4.1 (production row), §15, §16 (cost: what to watch).
- `SETUP.md` F (all ticked; if not, stop).

## Scope
1. **Production readiness PR** (agent):
   - Fill in `env.production` in `wrangler.jsonc`: hosts, IDs, the production `ACCESS_AUD`,
     the admin emails, an **empty** `ADMIN_SERVICE_CLIENTS`, and the contact values.
   - Production booth build config: the default `portal_url` is production.
   - The **release-build** booth APK (signing per `wiki/Android-Build.md`).
   - A diff checklist confirming that `DEV_AUTH` cannot be set in production (the config has no
     such var, and a test already covers the host check).
2. **Deploy** (you): merge, then `gh workflow run deploy-portal.yml` → approve the
   `production` job. Then:
   - `curl` `/healthz` on both hosts;
   - Access login works for both admins;
   - the `workers.dev` and preview URLs are disabled.
3. **Production dry run** (you and the agent, before the event):
   - Create a test event and enrol one booth.
   - Take 3 sessions, scan the QR code, and download.
   - Then delete the test event (the 7-day purge runs normally).
4. **Pilot event** (you):
   - Follow the runbook: before (enrol, select the event, test shot, phone scan, check storage
     and uplink), during (watch the booth badge and the admin devices view), after (close
     uploads only when every booth shows zero backlog).
   - The agent can watch production logs **read-only** through the API MCP or the dashboard.
5. **Reconcile** (agent, read-only):
   - Compare the SD-card shot count for completed sessions with READY photos in the portal.
   - Account for every difference: cancelled sessions, rejected photos, needs-attention items.
   - Review Workers errors and the Images and R2 usage against the DESIGN §16 estimates.
6. **Retrospective:**
   - Add to PROGRESS.md: what broke, what operators found confusing, the cost after the first
     month, and the backlog of post-MVP items (Keystore credential wrapping, strips, Previews,
     async processing if needed, SD-card recovery upload).

## Out of scope
- Any feature work. Issues found here become new sessions in a follow-up plan.

## Done when
- [ ] Production is deployed via the approval gate, with no manual `wrangler deploy`.
- [ ] The pilot event ran, and the counts reconcile, with every difference explained.
- [ ] The cost is in line with DESIGN §16, or the difference is explained.
- [ ] The retrospective and the post-MVP backlog are recorded.

## Hand-off
- Mark `wiki/Portal.md` and `wiki/Booth-Upload.md` as **live**, with the pilot date and
  results.
- Mark DESIGN.md as *implemented (MVP)*.
- PROGRESS.md final entry.

