# Session Start Hook - Kotlin Multiplatform Photobooth

This hook runs when a Claude Code session starts to validate the development environment for this Kotlin Multiplatform project.

## Project Overview
- **Type**: Kotlin Multiplatform with Compose Multiplatform
- **Targets**: Android, iOS, Desktop (JVM), Web (JS & Wasm)
- **Build System**: Gradle with Kotlin DSL
- **Main Module**: composeApp
- **Testing Framework**: kotlin.test (multiplatform testing library)
- **Development Approach**: Pragmatic testing with clean, modular code

## Development Cycle

This project follows a pragmatic testing approach:

1. **Implement**: Build clean, testable components
2. **Test**: Write comprehensive tests for completed components
3. **Refactor**: Improve code quality while keeping tests green

## Test Structure

- **commonTest/** - Tests that run on ALL platforms (write tests here first!)
- **androidUnitTest/** - Android-specific unit tests
- **jvmTest/** - Desktop/JVM-specific tests
- **jsTest/** - JavaScript-specific tests
- **wasmJsTest/** - WebAssembly-specific tests
- **iosTest/** - iOS-specific tests

## Validation Tasks

1. Check Gradle wrapper availability
2. Verify project structure
3. **Run all tests** to ensure baseline passes (ensures nothing is broken)
4. Validate test coverage

---

## Environment Check

Run the following commands to validate the development environment:

```bash
# Check if Gradle wrapper exists
if [ -f "./gradlew" ]; then
  echo "✓ Gradle wrapper found"

  # Try to run a simple Gradle command (may fail without network for first-time setup)
  if ./gradlew --version 2>/dev/null; then
    echo "✓ Gradle is working"
    echo ""
    echo "================================================"
    echo "🧪 Running all tests..."
    echo "================================================"

    # Run ALL tests across all platforms
    ./gradlew allTests --console=plain 2>&1 | tail -20

    TEST_RESULT=${PIPESTATUS[0]}

    if [ $TEST_RESULT -eq 0 ]; then
      echo ""
      echo "✅ All tests PASSED - Ready for development"
    else
      echo ""
      echo "❌ Some tests FAILED - Fix failing tests before starting new work"
      echo "   Run: ./gradlew allTests --rerun-tasks"
    fi

    echo ""
    echo "================================================"
    echo "📊 Testing Quick Reference"
    echo "================================================"
    echo "Test commands by target:"
    echo "  • All platforms:    ./gradlew allTests"
    echo "  • Common only:      ./gradlew cleanAllTests"
    echo "  • Android:          ./gradlew :composeApp:testDebugUnitTest"
    echo "  • Desktop/JVM:      ./gradlew :composeApp:jvmTest"
    echo "  • Web JS:           ./gradlew :composeApp:jsTest"
    echo "  • Web Wasm:         ./gradlew :composeApp:wasmJsTest"
    echo ""
    echo "Continuous testing (auto-run on changes):"
    echo "  • ./gradlew allTests --continuous"
    echo ""
    echo "Development workflow slash commands:"
    echo "  • /tdd-red      - Implement clean, testable component"
    echo "  • /tdd-green    - Write tests for implemented component"
    echo "  • /tdd-refactor - Refactor with test safety net"
    echo "  • /test-watch   - Run tests continuously"
  else
    echo "⚠ Gradle requires network access for first-time setup"
    echo "  Run: ./gradlew --version (when network is available)"
  fi
else
  echo "✗ Gradle wrapper not found"
  exit 1
fi

echo ""
echo "================================================"
echo "📱 Available build targets:"
echo "================================================"
echo "  - Android:  ./gradlew :composeApp:assembleDebug"
echo "  - Desktop:  ./gradlew :composeApp:run"
echo "  - Web Wasm: ./gradlew :composeApp:wasmJsBrowserDevelopmentRun"
echo "  - Web JS:   ./gradlew :composeApp:jsBrowserDevelopmentRun"
echo "  - iOS:      Open iosApp directory in Xcode"
```
