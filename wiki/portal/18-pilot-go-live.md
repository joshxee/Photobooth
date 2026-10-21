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
- DESIGN.md §4.1 (production row), §15, §16 (cost, Workers Free as a hard ceiling, and the
  50,000 requests/day trigger for Workers Paid); `spike/RESULTS.md` Q12 (event-day model).
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
   - Review Workers errors, R2 storage and operations, and D1 rows read and written against the
     DESIGN §16 estimates.
   - Read the pilot day's Workers requests (and the CPU p95 per route) from Workers analytics.
     Compare them with the §16 event-day table and its triggers. If the peak is over 50,000
     requests a day, or another trigger fired, recommend moving the account to Workers Paid
     (USD 5 a month; the plan covers staging and production) and **ask the user**; the agent
     never changes the plan.
6. **Retrospective:**
   - Add to PROGRESS.md: what broke, what operators found confusing, the cost after the first
     month, the Workers plan decision, and the backlog of post-MVP items (Keystore credential
     wrapping, strips, Previews, presigned uploads if §9.4's triggers fire, SD-card recovery
     upload).

## Out of scope
- Any feature work. Issues found here become new sessions in a follow-up plan.

## Done when
- [ ] Production is deployed via the approval gate, with no manual `wrangler deploy`.
- [ ] The pilot event ran, and the counts reconcile, with every difference explained.
- [ ] The cost and the event-day requests are in line with DESIGN §16, or the difference is
      explained, and the user has decided the Workers plan (stay Free or move to Paid).
- [ ] The retrospective and the post-MVP backlog are recorded.

## Hand-off
- Mark `wiki/Portal.md` and `wiki/Booth-Upload.md` as **live**, with the pilot date and
  results.
- Mark DESIGN.md as *implemented (MVP)*.
- PROGRESS.md final entry.

