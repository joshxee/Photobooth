---
description: Run tests for a specific platform
---

# Run Platform-Specific Tests

Run tests for a specific target platform instead of all platforms.

## Available Test Commands

### Common Tests (All Platforms)
```bash
./gradlew cleanAllTests
```
Runs tests in `commonTest` - these run on ALL platforms.

### Desktop/JVM Tests
```bash
./gradlew :composeApp:jvmTest
```
Runs tests in `jvmTest` + `commonTest` on the JVM.

### Android Tests
```bash
./gradlew :composeApp:testDebugUnitTest
```
Runs Android unit tests (not instrumented tests).

### Web JavaScript Tests
```bash
./gradlew :composeApp:jsTest
```
Runs tests in `jsTest` + `commonTest` for the JS target.

### Web WebAssembly Tests
```bash
./gradlew :composeApp:wasmJsTest
```
Runs tests in `wasmJsTest` + `commonTest` for the Wasm target.

### All Tests (All Platforms)
```bash
./gradlew allTests
```
Runs tests across ALL platforms - this is what CI should run!

## When to Use Platform-Specific Tests

- **During development** - Faster feedback loop for the platform you're working on
- **Platform-specific features** - Testing Android camera, iOS sensors, etc.
- **Debugging** - Isolate test failures to a specific platform

## Best Practice

Always write tests in `commonTest` first! Only use platform-specific tests when you need platform-specific APIs.

---

**Which platform tests would you like to run?**
