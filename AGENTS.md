# AGENTS.md

Single source of repo instructions for every agent harness (`CLAUDE.md` just points here).

## What this repo is

- **Booth:** a Tauri v2 photobooth for Android tablets. A Rust core owns all business logic, a React
  WebView only renders state and sends intent, and one Android plugin drives the camera hardware.
- **Portal (in progress):** a guest web portal on one Cloudflare Worker (`apps/portal`): live
  upload from the booth, a private guest gallery, an admin portal. The plan is in `wiki/portal/`.

## Directory map

| Path | What |
|------|------|
| `crates/photobooth-core` | `Camera` trait, session FSM, settings, in-memory photo store, mock camera (pure Rust) |
| `crates/sony-ptp` | Sony A7 III over PTP/USB, `Transport` trait, replay/recording |
| `plugins/tauri-plugin-photobooth-camera` | Android CameraX + USB host plugin, Rust `NativeCamera` |
| `apps/booth/src-tauri` | Tauri app: commands, `AppState`, `booth://` protocol, capabilities, `gen/android` (committed, hand-edited) |
| `apps/booth` | React 19 + TS UI, **bun only** (no npm, no Vite) |
| `apps/portal` | Cloudflare Worker (Hono) + two placeholder SPAs (gallery, admin); see `wiki/Portal.md` and `wiki/portal/` |
| `.maestro/tauri/` | Maestro flows for the Tauri debug build (CI and emulators) |
| `wiki/` | The *why* behind decisions, not structure. Read only the area you touch |
| `wiki/portal/` | The portal implementation plan: `README.md`, `DESIGN.md`, `PROGRESS.md`, `SETUP.md`, `REVIEW.md`, session files `NN-*.md` |

The tree holds only the Tauri app. The earlier Kotlin Multiplatform app is gone and shouldn't be restored.

## Commands (same as CI, `.github/workflows/ci.yml`)

```bash
cargo fmt --all -- --check
cargo clippy -p photobooth-core --all-targets -- -D warnings
cargo clippy -p sony-ptp --all-targets --all-features -- -D warnings
cargo clippy -p tauri-plugin-photobooth-camera --all-targets --all-features -- -D warnings
cargo clippy -p photobooth --all-targets -- -D warnings
cargo test -p photobooth-core
cargo test -p sony-ptp && cargo test -p sony-ptp --all-features
cargo test -p tauri-plugin-photobooth-camera && cargo test -p tauri-plugin-photobooth-camera --all-features
cargo test -p photobooth
cd apps/booth && bun install --frozen-lockfile && bun run typecheck && bun test && bun run build
```

- The `photobooth` crate embeds `apps/booth/dist`: run `bun run build` before building or testing it.
- Use `bun x tauri …`, not `bun run tauri` (it panics in `android init`).
- Android debug APK: `bun x tauri android build --apk --debug --ci --target aarch64 --config src-tauri/tauri.dev.conf.json`
  from `apps/booth`. On Windows use `pwsh apps/booth/scripts/build-android-debug.ps1 -Install`. See `wiki/Android-Build.md`.
- Portal, from `apps/portal` (CI job `portal`): `bun install --frozen-lockfile`, `bun run typecheck`,
  `bun run test` (Vitest in workerd for `src/worker`, then `bun test` for `src/web` and `scripts`), `bun run build`
  (both SPAs, then `wrangler deploy --dry-run` for local, staging and production). See
  `wiki/portal/README.md` → "Global definition of done".
- **Portal on this PC:** Wrangler and Vitest need Node on PATH, and `bunx wrangler` silently does nothing without it.
  Prefix commands: `fnm exec --using=22.11.0 -- bun run test`, or
  `fnm exec --using=22.11.0 -- node node_modules/wrangler/bin/wrangler.js dev`.
- **Portal local hosts:** the Worker routes on `Host`. Under `wrangler dev` (port 8787) the gallery/device host is
  `photos.localhost:8787` and the admin host is `admin.localhost:8787` (browsers resolve `*.localhost`; for curl use
  `curl -H "Host: photos.localhost:8787" http://localhost:8787/healthz`, port included). Any other host is a 404.
- **Portal admin locally:** `fnm exec --using=22.11.0 -- node node_modules/wrangler/bin/wrangler.js dev --var DEV_AUTH:1`
  skips Access on `*.localhost` hosts only (actor `dev@admin.localhost`). Admin mutations also need
  `-H "Origin: http://admin.localhost:8787" -H "Content-Type: application/json"`.
- **Portal local data:** from `apps/portal`, `fnm exec --using=22.11.0 -- bun run migrate:local` (D1 migrations, local
  only), then `fnm exec --using=22.11.0 -- bun run seed`. The seed (`scripts/seed.ts`) **replaces** the local D1 and R2
  contents with two events (OPEN/LIVE and CLOSED/LIVE), one enrolled device and READY photos with placeholder JPEGs,
  and prints the gallery links and a local-only device credential. Inspect it with `wrangler dev` → `/cdn-cgi/local/explorer`
  or `wrangler d1 execute DB --local --command "…"`. The API contract is `apps/portal/src/shared/schemas.ts` plus
  `apps/portal/contract/` (fixtures and manifest); see `wiki/Portal.md`.

## Definition of done

- fmt, clippy (`-D warnings`) and tests are clean for every touched crate; frontend typecheck, test and build are clean.
- No suppressions (`allow(...)`, `@ts-ignore`, `eslint-disable`, `.skip`) added to make checks pass.
- Hardware-facing change: update its wiki page and label anything not run on the tablet as **unverified**.
  Anything not run against real Cloudflare is labelled the same way.
- Portal work follows `wiki/portal/README.md` (branch `portal/NN-short-name`, PROGRESS.md entry, PR, independent review).

## Hard rules

- Business logic lives in Rust. The WebView renders state and sends intent.
- Photos are held in memory only (`PhotoStore`, one session). The one exception is the portal upload outbox,
  which stores a shot until the server confirms READY and then deletes it. Never write photos to disk elsewhere.
- Commands are least-privilege: `test_inject` and `logs_recent` are available only through the `dev` capability.
- The repo is **public**: no secrets, tokens, real guest photos or share links.
- Agents never deploy to production and never hold a Cloudflare write token. Staging deploys go through CI.

## Where to look

- `wiki/` for the reasons behind decisions. Start at `wiki/README.md`.
- `wiki/portal/` for the active plan. **Read `wiki/portal/PROGRESS.md` before any portal work.**

## Agent tooling

- **Cloudflare docs:** append `/index.md` to any Cloudflare docs URL, or use `https://developers.cloudflare.com/llms.txt`.
- **MCP servers** (`.mcp.json`): Cloudflare Docs (`https://docs.mcp.cloudflare.com/mcp`) and Cloudflare API
  (`https://mcp.cloudflare.com/mcp`). Use the API MCP with the **read-only** token only; never production writes.
- **Cloudflare Skills plugin** (Workers, Wrangler, R2, D1 best practice), installed once per machine in Claude Code:
  `/plugin marketplace add cloudflare/skills` then `/plugin install cloudflare@cloudflare`.
- Other tools used by the portal plan are listed in `wiki/portal/README.md` → "Agent tooling".

## Device testing (Windows PC + Xiaomi Pad 6 tablet)

When `adb devices -l` shows `device:pipa`, test on the tablet without the user stepping in.
Rationale: `wiki/Android-Build.md` → "adb over Wi-Fi".

- **Connect over Wi-Fi, not USB.** The Sony is cabled to the tablet's only USB-C port, so adb uses Android
  Wireless debugging (already paired with this PC). Run `pwsh apps/booth/scripts/connect-tablet.ps1` first.
  Don't ask the user to swap cables.
- **Can't find the tablet?** Ask the user to turn on Settings → Additional settings → Developer options →
  Wireless debugging. Re-pair (`-Pair <code>`) only for a new PC. Don't `adb connect ip:port` by hand: it races
  adb's mDNS auto-connect, lists the tablet twice, and every plain `adb` command then fails.
- `adb` is not on PATH: `$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe`.
- **Build + install:** `pwsh apps/booth/scripts/build-android-debug.ps1 -Install` (PowerShell 7). It connects first.
- **Drive the app with plain adb, not Maestro.** Use `exec-out screencap -p`, `shell input tap x y`
  (2880×1800 landscape), `input keyevent`, `am start -n com.jc.photobooth.tauri/com.jc.photobooth.MainActivity`,
  `uiautomator dump`, `logcat -s Photobooth` and `run-as com.jc.photobooth.tauri`. Maestro makes MIUI show an
  "Install via USB" prompt on every run, so keep Maestro (`.maestro/tauri/`) for CI and emulators.
- **Never uninstall `com.jc.photobooth`** (the user's earlier app, different signing key). The Tauri debug build is
  `com.jc.photobooth.tauri`.
