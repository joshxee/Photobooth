---
description: Run tests continuously (auto-run on changes)
---

# Continuous Testing (Watch Mode)

Run tests automatically whenever you save a file. Perfect for TDD workflow!

## Run Continuous Tests

```bash
# Watch all tests across all platforms
./gradlew allTests --continuous

# Watch specific platform tests
./gradlew :composeApp:jvmTest --continuous        # Desktop only
./gradlew :composeApp:jsTest --continuous         # Web JS only
./gradlew :composeApp:wasmJsTest --continuous     # Web Wasm only
```

## How It Works

1. Gradle watches your source and test files
2. When you save a file, tests automatically re-run
3. Get immediate feedback on your changes
4. Press `Ctrl+C` to stop watching

## TDD Workflow with Watch Mode

1. Start watch mode: `./gradlew allTests --continuous`
2. Write a failing test (Red) - tests auto-run and fail
3. Write implementation (Green) - tests auto-run and pass
4. Refactor code - tests auto-run after each change

## Benefits

- **Instant feedback** - Know immediately if you broke something
- **Focus** - Stay in the flow, don't context switch to run tests manually
- **Confidence** - Refactor fearlessly with automatic test verification

---

**Starting continuous test mode...** Tests will run automatically on file changes.
