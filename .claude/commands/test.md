---
description: Run all tests across all platforms
---

# Run All Tests

Run the complete test suite across all platforms. This is the **primary command** for TDD workflow.

```bash
./gradlew allTests --console=plain
```

## TDD Best Practice

In Test-Driven Development, you should run tests:

1. **Before** starting work - Ensure baseline is green ✅
2. **After** writing a test - Verify it fails (Red phase) 🔴
3. **After** implementing code - Verify it passes (Green phase) 🟢
4. **After** each refactoring - Ensure nothing broke (Refactor phase) 🔵

## Test Output

The command shows:
- Number of tests executed
- Passed/Failed/Skipped counts
- Test execution time
- Platform-specific results

## Other Test Commands

See also:
- `/tdd-red` - Write a failing test (TDD Red phase)
- `/tdd-green` - Make tests pass (TDD Green phase)
- `/tdd-refactor` - Refactor safely (TDD Refactor phase)
- `/test-watch` - Run tests continuously
- `/test-platform` - Run tests for specific platform

## Platform-Specific Tests

To run tests for a specific target:
- All platforms: `./gradlew allTests`
- Common tests: `./gradlew cleanAllTests`
- Android tests: `./gradlew :composeApp:testDebugUnitTest`
- Desktop tests: `./gradlew :composeApp:jvmTest`
- Web JS tests: `./gradlew :composeApp:jsTest`
- Web Wasm tests: `./gradlew :composeApp:wasmJsTest`
