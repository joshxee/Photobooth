# Portal implementation plan

This plan builds the Photobooth Portal MVP described in [DESIGN.md](./DESIGN.md): live upload
from the booth, a private guest gallery, an admin portal, and a single Cloudflare Worker. It is
split into **sessions**. Each session fits one agent context window, ends in one PR, and leaves
`main` in a mergeable state.

Everything the plan needs lives in this folder. The `wiki/` is updated as each session lands,
with the *why* of what was built: trade-offs and known limitations, not a restatement of this
plan.

| File | Purpose |
|---|---|
| [DESIGN.md](./DESIGN.md) | The accepted solution design (source of truth for behaviour) |
| [PROGRESS.md](./PROGRESS.md) | Hand-off log: one entry per session, newest first. **Read it first.** |
| [SETUP.md](./SETUP.md) | One-time human steps (account, domain, Access, tokens), done by hand |
| [REVIEW.md](./REVIEW.md) | Checklist for the independent reviewer of each session's PR |
| [design/](./design/) | Visual starting point for the gallery and post-shoot screen (from a Claude design session) |
| `NN-*.md` | The sessions |

## Sessions and dependencies

```
00 agent foundation ─► 01 spike ─► 02 portal scaffold ─► 03 schema + contracts
                                                            │
             ┌──────────────────────────────────────────────┴──────────────┐
             ▼  portal track                                               ▼  booth track
   04 admin auth + events API                                    08 booth outbox
   05 devices + enrolment API                                    09 booth portal client, enrolment, event selection
   06 upload + processing ──► 07 staging + CI deploy (SETUP B–E) 10 booth upload loop + operator status
   11 guest access + gallery API                                       │
   12 gallery UI (needs design/)                                       │
   14 admin UI: events, QR, devices                                    │
   15 admin UI: moderation, audit                                      │
   16 retention + deletion                                             │
             └──────────────► 13 booth post-shoot QR (needs 10, 11, 12) ◄──┘
                                      ▼
                          17 hardening + release gates
                                      ▼
                          18 pilot + production go-live
```

| # | Session | Depends on | Device check | Human gate |
|---|---|---|---|---|
| 00 | [Agent foundation](./00-agent-foundation.md) | — | n/a | — |
| 01 | [Spike](./01-spike.md) | 00, SETUP A | n/a | Supplies sample JPEGs; go/no-go |
| 02 | [Portal scaffold](./02-portal-scaffold.md) | 01 | n/a | — |
| 03 | [Schema and contracts](./03-schema-contracts.md) | 02 | n/a | — |
| 04 | [Admin auth and events API](./04-admin-auth-events.md) | 03 | n/a | — |
| 05 | [Devices and enrolment API](./05-devices-enrolment.md) | 04 | n/a | — |
| 06 | [Upload and processing](./06-upload-processing.md) | 05 | n/a | — |
| 07 | [Staging and CI deploy](./07-staging-ci.md) | 06, SETUP B–E | n/a | Approves first deploy |
| 08 | [Booth outbox](./08-booth-outbox.md) | 03 | automated | — |
| 09 | [Booth portal client, enrolment, event selection](./09-booth-client-enrolment.md) | 05, 08 | automated | — |
| 10 | [Booth upload loop and operator status](./10-booth-upload-status.md) | 06, 09 (07 for the device run) | **critical** | Once-over on the tablet |
| 11 | [Guest access and gallery API](./11-guest-api.md) | 06 | n/a | — |
| 12 | [Gallery UI](./12-gallery-ui.md) | 11, `design/` | n/a (browser) | Design sign-off |
| 13 | [Booth post-shoot QR](./13-booth-post-shoot.md) | 10, 12 | **critical** | Once-over on the tablet |
| 14 | [Admin UI: events, QR, devices](./14-admin-ui-events-devices.md) | 05, 11 | n/a (browser) | — |
| 15 | [Admin UI: moderation and audit](./15-admin-ui-moderation.md) | 14 | n/a (browser) | — |
| 16 | [Retention and deletion](./16-retention-deletion.md) | 06, 11 | n/a | — |
| 17 | [Hardening and release gates](./17-hardening-gates.md) | all of 00–16 | **critical** | Runs critical gates |
| 18 | [Pilot and go-live](./18-pilot-go-live.md) | 17, SETUP F | **critical** | Real event |

The two tracks can run in parallel once session 03 has merged. The session fixtures in
`apps/portal/contract/fixtures/` are the shared contract between them. Within a track, run
sessions in order.

**Device check levels** (decided with the user):
- **automated**: the agent verifies on the tablet itself (adb: `screencap`, `input`,
  `uiautomator dump`, `logcat`; Maestro where the install prompt allows). No human needed.
- **critical**: the agent runs the automated checks first, then you do a short manual
  once-over on the tablet. The session is not done until you have ticked it in PROGRESS.md.
  Critical flows are capture → upload, crash and offline durability, QR → gallery, and the
  release gates.

## How to run a session (agent)

1. Read `AGENTS.md`, then this README, then [PROGRESS.md](./PROGRESS.md), then the session file.
   Read only the DESIGN sections and files the session lists under *Read first*.
2. Check that the session's dependencies are merged (PROGRESS.md). If not, stop and say so.
3. Create a branch: `portal/NN-short-name`.
4. Work test-first. Commit small, compiling steps with conventional messages
   (`feat(portal): …`, `test(booth): …`).
5. Run the session's **Verify** commands, then the global definition of done (below).
6. Update the wiki pages listed under *Hand-off*. If the implementation differs from DESIGN.md,
   change DESIGN.md in the same PR and say why in the PR body. Never let them drift silently.
7. Add a PROGRESS.md entry (template in that file) and open the PR.
8. Ask for an independent review: a fresh context (a `cavecrew-reviewer` subagent or a new
   session) using [REVIEW.md](./REVIEW.md). Fix the findings or justify them in the PR.
9. Stop. Do not start the next session in the same context.

**If the context is running out:** stop at the last green commit, push, and write a PROGRESS
entry marked `PARTIAL` that lists exactly what remains. The next session resumes from there.
Never leave uncommitted or half-wired work.

**If the session is bigger than expected:** do not expand scope to finish it. Split the
remainder into `NNb-*.md` in this folder, link it from this README, and stop.

## Global definition of done

Portal (`apps/portal`):
```bash
bun install --frozen-lockfile
bun run typecheck
bun run test          # vitest (Worker, inside workerd) + bun test (SPAs)
bun run build         # both SPAs + wrangler deploy --dry-run
```
Booth (unchanged from wiki/Tauri-Workstreams.md): `cargo fmt --all -- --check`,
`cargo clippy … -D warnings` for the touched crates, `cargo test` for the touched crates, and
in `apps/booth` `bun run typecheck && bun test && bun run build`.

Always:
- No suppressions (`allow(...)`, `@ts-ignore`, `eslint-disable`, `.skip`) added to make
  checks pass.
- Anything not exercised against real Cloudflare or the real tablet is **labelled as such** in
  the wiki page and in PROGRESS.md.
- No secrets, tokens, real guest photos or share links committed. The repo is **public**.

## Cross-cutting rules (all sessions)

- DESIGN.md is the behaviour spec. A session may refine it but not contradict it silently.
- Hard constraints:
  - The booth deletes a shot as soon as the server confirms READY, and shots from cancelled
    sessions never upload.
  - Test-mode shots never upload.
  - The MVP gallery shows single images only.
- `processPhoto()` takes no HTTP types, so the asynchronous path described in DESIGN.md §9.4
  stays a server-only change.
- Agents never deploy to production and never hold a Cloudflare write token. Staging deploys go
  through the `deploy-staging` workflow.
- New dependencies: only those listed in DESIGN.md §5 or the session file. Any other addition
  needs a one-line justification in the PR. Keep the dependency footprint lean.

## Agent tooling

Set up in session 00; all of it is free.

| Tool | Use |
|---|---|
| `AGENTS.md` (+ `CLAUDE.md` pointer) | Repo map, commands, rules, read by every harness |
| Cloudflare Skills plugin (`cloudflare/skills`) | Workers, Wrangler, R2 and D1 best practice, loaded on demand |
| Cloudflare Docs MCP (`https://docs.mcp.cloudflare.com/mcp`) | Current docs. Also append `/index.md` to any docs URL, or use `…/llms.txt` |
| Cloudflare API MCP (`https://mcp.cloudflare.com/mcp`, Code Mode) | Read-only: staging logs, resource state. Never production writes |
| `wrangler dev` + Local Explorer (`/cdn-cgi/local/explorer`) | Inspect local D1 rows and R2 objects, and run the scheduled handler, while debugging |
| `apps/portal/scripts/seed.ts` | Deterministic local data (events, devices, photos) |
| `apps/portal/scripts/smoke.ts --base <url>` | End-to-end device → gallery flow against local or staging |
| `chrome-devtools-axi` | Checks on the gallery and admin UIs (keyboard, layout, console, network) |
| adb / Maestro | Tablet checks (see the device check levels above) |
| `gh-axi` | PRs, CI runs, triggering `deploy-staging` |

