---
description: TDD Green Phase - Make tests pass
---

# TDD Green Phase 🟢

In the **Green** phase of Test-Driven Development, you write the minimal code needed to make the failing test pass.

## Instructions

I will help you:

1. **Review the failing test** - Understand what needs to be implemented
2. **Write minimal implementation** - Just enough to make the test pass (no more!)
3. **Run the tests** - Verify all tests pass
4. **Confirm success** - Ensure the new test passes along with all existing tests

## Run Tests

```bash
# Run all tests
./gradlew allTests --console=plain

# Run tests continuously (auto-run on file changes)
./gradlew allTests --continuous

# Run specific platform tests
./gradlew :composeApp:jvmTest        # Desktop/JVM
./gradlew :composeApp:jsTest         # Web JS
./gradlew :composeApp:wasmJsTest     # Web Wasm
```

## Best Practices

- Write the **simplest** code that makes the test pass
- Don't add features that aren't tested yet
- Keep the implementation in `composeApp/src/commonMain/kotlin/` for cross-platform code
- Resist the urge to refactor now - that's the next phase!

## After Running This Command

Once all tests are passing (green), use `/tdd-refactor` to improve the code quality.

---

**Let's make those tests pass!** I'll implement the minimal code needed.
