# CLAUDE.md

Tauri v2 photobooth for Android tablets: a Rust core, a React WebView, and one Android camera plugin.

## Layout

| Path | What |
|------|------|
| `crates/photobooth-core` | `Camera` trait, session FSM, settings, in-memory photo store, mock camera (pure Rust) |
| `crates/sony-ptp` | Sony A7 III over PTP/USB, `Transport` trait, replay/recording |
| `plugins/tauri-plugin-photobooth-camera` | Kotlin CameraX + USB host, Rust `NativeCamera` |
| `apps/booth/src-tauri` | Tauri app: commands, `AppState`, `booth://` protocol, capabilities, `gen/android` (committed, hand-edited) |
| `apps/booth` | React 19 + TS UI, **bun only** (no npm, no Vite) |
| `composeApp/`, `iosApp/`, `.maestro/flows/` | Legacy Kotlin Multiplatform app. Frozen until cutover; don't change it unless asked |

## Check before committing (same as CI)

```bash
cargo fmt --all -- --check
cargo clippy -p <crate> --all-targets --all-features -- -D warnings   # no allow() suppressions
cargo test -p <crate>
cd apps/booth && bun run typecheck && bun test && bun run build
```

The `photobooth` crate embeds `apps/booth/dist`, so run `bun run build` before building or testing it.

## Rules

- Business logic lives in Rust. The WebView only renders state and sends intent.
- Never write photos to disk. They stay in `PhotoStore` memory for one session.
- `test_inject` and `logs_recent` are available only through the `dev` capability.
- Use `bun x tauri …`, not `bun run tauri` (it panics in `android init`).
- If you change something hardware-facing, update its wiki page and label anything not run on the tablet as unverified.

## Docs

Read `wiki/` only for the area you're touching. It holds the reasons behind decisions, not structure:
`Tauri-Migration-Plan.md` (settled decisions, don't re-argue them), `Tauri-Workstreams.md` (contracts),
`Android-Build.md`, `Frontend.md`, `Tauri-App.md`, `Core-Domain.md`, `Wired-Camera-Protocol.md`, `Native-Camera-Plugin.md`.
Device testing: `.maestro/tauri/README.md` (adb locally, Maestro for CI and emulators).
