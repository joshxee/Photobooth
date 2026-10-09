# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project Overview

**Kotlin Multiplatform** photobooth app (Android, iOS, Desktop/JVM, Web JS+Wasm) using **Compose Multiplatform**. Package `com.jc.photobooth`.

## Knowledge Graph (READ FIRST)

This repo has a graphify-built knowledge graph. **Before grepping or globbing for structural questions, read `graphify-out/GRAPH_REPORT.md`** — it has god nodes, community labels, and surprising connections. For deep traversal use:

- `/graphify query "<question>"` — BFS traversal of `graph.json`
- `/graphify path "NodeA" "NodeB"` — shortest path between concepts
- `/graphify explain "NodeName"` — node + neighbors

**Rebuild after a feature lands** (or after a refactor that adds/renames files):

```bash
/graphify --update    # incremental — only re-extracts changed files
```

The graph (`graph.json`, `GRAPH_REPORT.md`, `manifest.json`, `cost.json`, `.graphify_labels.json`) is committed. The HTML viz and per-machine caches are gitignored.

## Build & Run

| Target | Command |
|--------|---------|
| Android | `./gradlew :composeApp:assembleDebug` |
| Desktop (JVM) | `./gradlew :composeApp:run` |
| Web (Wasm) | `./gradlew :composeApp:wasmJsBrowserDevelopmentRun` |
| Web (JS) | `./gradlew :composeApp:jsBrowserDevelopmentRun` |
| iOS | open `iosApp/` in Xcode |

Slash commands: `/build-android`, `/build-desktop`, `/build-web`, `/clean`.

## Test

```bash
./gradlew allTests                            # all platforms (run before commits)
./gradlew :composeApp:jvmTest                 # desktop only
./gradlew :composeApp:testDebugUnitTest       # android only
./gradlew :composeApp:jsTest                  # web JS only
./gradlew :composeApp:wasmJsTest              # web Wasm only
./gradlew allTests --continuous               # watch mode
```

Slash commands: `/test`, `/test-platform`, `/test-watch`.

## Device Testing (Windows PC + Xiaomi tablet)

When developing on the Windows PC with the Xiaomi Pad 6 (`adb devices -l` shows `device:pipa`), this is the
suggested way to test on the device. The aim is to test without the user stepping in. Rationale:
`wiki/Android-Build.md` → "adb over Wi-Fi".

- **Connect over Wi-Fi, not USB.** The Sony is cabled to the tablet's only USB-C port, so adb uses Android
  Wireless debugging (already paired with this PC). Run `pwsh apps/booth/scripts/connect-tablet.ps1` first.
  Don't ask the user to swap cables.
- **Can't find the tablet?** Ask the user to turn on Settings → Additional settings → Developer options →
  Wireless debugging. Re-pair (`-Pair <code>`) only for a new PC. Don't `adb connect ip:port` by hand: it
  races adb's mDNS auto-connect, lists the tablet twice, and every plain `adb` command then fails.
- `adb` is not on PATH: `$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe`.
- **Build + install:** `pwsh apps/booth/scripts/build-android-debug.ps1 -Install` (PowerShell 7). It connects first.
- **Drive the app with plain adb, not Maestro.** Use `exec-out screencap -p`, `shell input tap x y`
  (2880×1800 landscape), `input keyevent`, `am start -n com.jc.photobooth.tauri/com.jc.photobooth.MainActivity`,
  `uiautomator dump`, `logcat -s Photobooth` and `run-as com.jc.photobooth.tauri`. Maestro makes MIUI show an
  "Install via USB" prompt on every run, so keep Maestro (`.maestro/tauri/`) for CI and emulators.
- **Never uninstall `com.jc.photobooth`** (the user's Kotlin app, different signing key). The Tauri debug
  build is `com.jc.photobooth.tauri`.

## Source Set Structure

```
composeApp/src/
├── commonMain/      # shared code — put new code here first
├── commonTest/      # shared tests — write tests here first
├── androidMain/     # Android-specific
├── iosMain/         # iOS-specific
├── jvmMain/         # Desktop/JVM-specific
├── jsMain/          # Web JS-specific
└── wasmJsMain/      # Web Wasm-specific
```

For platform-specific APIs (camera, gps, filesystem) use `expect`/`actual`. Never hardcode platform checks.

## TDD

Strict Red-Green-Refactor. Write tests in `commonTest` first — they run on all platforms. Tooling via ECC `tdd-workflow` skill.

Slash commands: `/tdd-red`, `/tdd-green`, `/tdd-refactor`.

## Key Principles

1. Maximize code sharing — write in `commonMain` first
2. Test first (RED → GREEN → REFACTOR)
3. Cross-platform tests in `commonTest` unless platform-specific
4. Platform abstraction via `expect`/`actual`
5. Run `./gradlew allTests` before commits

## Wiki

`wiki/` contains design rationale and trade-offs. Camera work → start at `wiki/Camera-System.md`.

The graph already encodes structure (files, classes, calls) and rationale (decisions tagged `file_type:"rationale"`). Keep the wiki for the **why**: trade-offs considered, alternatives rejected, known limitations. Skip restating structure the graph already has.

When you ship a feature, add or update a wiki entry that explains the *why*, then run `/graphify --update` so the graph picks it up.

## Other Docs

- `README.md` — build/run for each platform
- `wiki/` — architecture rationale
- `graphify-out/GRAPH_REPORT.md` — graph summary (god nodes, communities, surprising edges)
