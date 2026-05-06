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
