# 00 — Agent foundation (prerequisite)

**Goal:** every later session starts from accurate repo instructions and the same free agent
tooling. Today `CLAUDE.md` still describes the deleted Kotlin/Compose app, its slash commands
and the graphify graph (removed in the Tauri cutover).

- **Depends on:** nothing.
- **Unlocks:** all sessions.
- **Device check:** n/a.

## Read first
- `CLAUDE.md` (stale), `README.md`, `wiki/README.md`, `wiki/Tauri-Workstreams.md` (directory
  ownership and definition of done).
- `.github/workflows/ci.yml` (the real commands), `apps/booth/package.json`, root `Cargo.toml`.
- `.claude/settings.json`.
- `wiki/portal/README.md` (this plan's conventions).

## Scope
1. **Create `AGENTS.md`** at the repo root, the single source for every harness, about 120 lines
   at most:
   - What the repo is: the Tauri 2 booth (Rust core, React WebView, Android), and the portal
     (Cloudflare Worker, coming).
   - A directory map, taken from `wiki/Tauri-Workstreams.md`, plus `apps/portal` and
     `wiki/portal`.
   - Build, test and lint commands copied from CI, so they are actually correct. Include the
     Android build and the adb-based tablet testing notes (see
     `wiki/Tauri-Migration-Plan.md`, *Testing*).
   - The definition of done.
   - Hard rules:
     - Photos are held in memory only, except in the outbox, which deletes each shot on READY.
     - Commands are least-privilege.
     - The repo is public, so no secrets.
     - Agents never deploy production.
   - Where to look: wiki for the why; `wiki/portal/` for the active plan; *read PROGRESS.md
     before portal work*.
   - Tooling: Cloudflare skills/MCP, `/index.md` on any Cloudflare docs URL, `llms.txt`.
2. **Replace `CLAUDE.md`** with a pointer: `@AGENTS.md` plus one line on Claude-specific
   settings. Remove all Kotlin, Compose, Gradle, slash-command and graphify content.
3. **Fix `README.md`** wherever it still describes Kotlin or Gradle builds. Keep it short and
   link to AGENTS.md.
4. **Agent tooling config** (checked in, no secrets):
   - Add a project `.mcp.json` with the Cloudflare Docs MCP
     (`https://docs.mcp.cloudflare.com/mcp`) and the Cloudflare API MCP
     (`https://mcp.cloudflare.com/mcp`). Add a comment in AGENTS.md that the API MCP is used
     with the **read-only** token only.
   - Document in AGENTS.md how to install the Cloudflare Skills plugin
     (`/plugin marketplace add cloudflare/skills`, `/plugin install cloudflare@cloudflare`).
     If the harness supports it, enable it in `.claude/settings.json` alongside the existing
     LSP plugins.
5. **Wiki index:** add `wiki/portal/` and the forthcoming `Portal.md` and `Booth-Upload.md`
   entries to `wiki/README.md` under a "Portal (in progress)" heading.
6. **`.gitignore`:** add `wiki/portal/spike/fixtures/`, `apps/portal/.wrangler/`,
   `apps/portal/dist/`, `.dev.vars*`, `crates/*/target/` and stray `crates/*/Cargo.lock`
   (they appear in `git status` today; check they aren't wanted before ignoring).

## Out of scope
- Any portal or booth code.
- New slash commands or a custom skill. Add them later only if a session repeatedly needs one.
- Rebuilding graphify.

## Verify
```bash
git grep -n -i -E "kotlin|compose|gradle|graphify|composeApp" -- AGENTS.md CLAUDE.md README.md   # expect no hits
# Every command listed in AGENTS.md runs as written (spot-check: cargo test -p photobooth-core; cd apps/booth && bun run typecheck)
```

## Done when
- [ ] `AGENTS.md` exists and is accurate. `CLAUDE.md` is a pointer. `README.md` has no stale
      platform content.
- [ ] `.mcp.json` is present and the skills install is documented.
- [ ] `.gitignore` is updated, and `git status` is clean apart from intentional changes.
- [ ] The wiki index links to the plan.

## Hand-off
- PROGRESS.md entry. No other wiki page changes.

