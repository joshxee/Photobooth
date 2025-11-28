# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Kotlin Multiplatform** photobooth application targeting Android, iOS, Desktop (JVM), and Web (JS/Wasm) platforms using **Compose Multiplatform** for shared UI.

**Package:** `com.jc.photobooth`

## Development Commands

### Building & Running

**Android**
```bash
./gradlew :composeApp:assembleDebug
# Slash command: /build-android
```

**Desktop (JVM)**
```bash
./gradlew :composeApp:run
# Slash command: /build-desktop
```

**Web (Wasm - faster, modern browsers)**
```bash
./gradlew :composeApp:wasmJsBrowserDevelopmentRun
```

**Web (JS - broader compatibility)**
```bash
./gradlew :composeApp:jsBrowserDevelopmentRun
# Slash command: /build-web
```

**iOS**
- Open `iosApp` directory in Xcode and run from there

### Testing

**Run all tests across all platforms** (recommended before commits)
```bash
./gradlew allTests
# Slash command: /test
```

**Platform-specific tests**
```bash
./gradlew :composeApp:jvmTest                  # Desktop
./gradlew :composeApp:testDebugUnitTest        # Android
./gradlew :composeApp:jsTest                   # Web JS
./gradlew :composeApp:wasmJsTest              # Web Wasm
# Slash command: /test-platform
```

**Continuous testing for TDD**
```bash
./gradlew allTests --continuous
# Slash command: /test-watch
```

### Cleaning

```bash
./gradlew clean
# Slash command: /clean
```

## Architecture

### Source Set Structure

```
composeApp/src/
├── commonMain/          # Shared code for ALL platforms (put code here first!)
├── commonTest/          # Shared tests for ALL platforms (write tests here first!)
├── androidMain/         # Android-specific implementations
├── iosMain/            # iOS-specific implementations
├── jvmMain/            # Desktop/JVM-specific implementations
├── jsMain/             # Web JS-specific implementations
└── wasmJsMain/         # Web Wasm-specific implementations
```

### expect/actual Pattern

Use `expect`/`actual` for platform-specific APIs (Camera, GPS, file system, etc.):

**commonMain (declare interface)**
```kotlin
expect fun getPlatform(): Platform
```

**Platform source sets (implement)**
```kotlin
// androidMain/Platform.android.kt
actual fun getPlatform(): Platform = AndroidPlatform()

// iosMain/Platform.ios.kt
actual fun getPlatform(): Platform = IOSPlatform()

// jvmMain/Platform.jvm.kt
actual fun getPlatform(): Platform = JVMPlatform()
```

### Current App Structure

The app uses a simple navigation pattern with a `Screen` enum:
- `WELCOME` - Welcome screen with "Enter the Booth" button
- `PHOTOBOOTH` - Camera capture screen with countdown and photo capture
- `PHOTO_STRIP` - Display screen showing captured photos
- `UNDER_CONSTRUCTION` - Placeholder screen

Main composable: `App()` in `composeApp/src/commonMain/kotlin/com/jc/photobooth/App.kt`

**Key Features:**
- Camera permission handling with proper state management
- CameraX integration (Android) with YUV to JPEG conversion
- Photo booth with countdown timer and multi-photo capture
- Photo strip display with captured photos
- ViewModel-based state management with coroutines

See `wiki/` directory for detailed architecture and implementation documentation.

## Test-Driven Development (TDD)

**This project strictly follows TDD practices.** All feature development must use the Red-Green-Refactor cycle.

### TDD Cycle

1. **🔴 RED** - Write a failing test in `commonTest` first
2. **🟢 GREEN** - Write minimal code in `commonMain` to make it pass
3. **🔵 REFACTOR** - Improve code while keeping tests green

### TDD Slash Commands

- `/tdd-red` - Write a failing test (Red phase)
- `/tdd-green` - Implement to make tests pass (Green phase)
- `/tdd-refactor` - Refactor code safely (Refactor phase)

### Testing Framework

Uses `kotlin.test` library for cross-platform testing:
```kotlin
import kotlin.test.*

@Test
fun shouldDoSomething() {
    val result = doSomething()
    assertEquals(expected, result)
}
```

**Always write tests in `commonTest` first** - they run on all platforms automatically.

## Key Principles

1. **Maximize code sharing** - Write in `commonMain` whenever possible
2. **Test first** - Follow TDD strictly (Red-Green-Refactor)
3. **Cross-platform tests** - Write tests in `commonTest` unless platform-specific
4. **Platform abstraction** - Use expect/actual for platform APIs, never hardcode platform checks
5. **Run all tests** - Use `./gradlew allTests` before commits to verify all platforms

## Dependencies

**Common dependencies** (available to all platforms) are in `commonMain.dependencies`:
- Compose Runtime, Foundation, Material3, UI
- Lifecycle ViewModel & Runtime Compose

**Platform-specific dependencies** use separate source set dependencies (e.g., `androidMain.dependencies`)

## Subagent

A Kotlin Multiplatform specialist subagent is available at `.claude/subagents/kotlin-multiplatform.md` with deep expertise in KMP patterns, best practices, and troubleshooting.

## Technical Wiki

**Location:** `wiki/` directory

The wiki contains technical documentation about architecture, design decisions, and implementation details.

### Wiki Structure

- `wiki/README.md` - Wiki overview and navigation
- `wiki/Architecture.md` - System design and architectural decisions
- `wiki/Camera-System.md` - Camera implementation details and trade-offs
- `wiki/State-Management.md` - State handling patterns and ViewModel architecture
- `wiki/Testing-Strategy.md` - Test organization and coverage approach
- `wiki/Platform-Support.md` - Cross-platform implementation details

### Wiki Maintenance (IMPORTANT)

**You MUST update the wiki whenever you:**

1. **Add a new feature** - Document:
   - Design decisions and reasoning
   - Trade-offs considered
   - Implementation approach
   - Platform-specific details (if any)

2. **Refactor existing code** - Update:
   - Architecture docs if structure changes
   - Implementation details if approach changes
   - Add notes about why refactoring was needed

3. **Remove features** - Document:
   - What was removed and why
   - Any migration notes
   - Alternative approaches chosen

4. **Make architectural decisions** - Document:
   - The decision made
   - Alternatives considered
   - Reasoning for the choice
   - Known limitations or trade-offs

### What to Document

Focus on the **why**, not just the **what**:
- ✅ "We use suspend functions for camera capture to avoid main thread deadlock"
- ❌ "The camera uses CameraX"

Emphasize **trade-offs and decisions**:
- ✅ "We chose MINIMIZE_LATENCY over MAXIMIZE_QUALITY because photobooth users expect fast capture"
- ❌ "CameraX is configured with MINIMIZE_LATENCY mode"

Include **known limitations**:
- ✅ "Photos are not persisted to storage - intentional for initial MVP"
- ❌ "Photos are stored in memory"

### When NOT to Update Wiki

- Trivial bug fixes (typos, minor corrections)
- Dependency version bumps (unless behavior changes)
- Test additions that don't change architecture
- Documentation improvements (unless adding new patterns)

## Additional Documentation

- **TDD Guidelines**: `.claude/TDD_GUIDELINES.md` - Comprehensive TDD practices and examples
- **Project README**: `README.md` - Build and run instructions for each platform
- **Technical Wiki**: `wiki/` - Architecture, design decisions, and implementation details
