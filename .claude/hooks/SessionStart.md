# Session Start Hook - Kotlin Multiplatform Photobooth

This hook runs when a Claude Code session starts to validate the development environment for this Kotlin Multiplatform project.

## Project Overview
- **Type**: Kotlin Multiplatform with Compose Multiplatform
- **Targets**: Android, iOS, Desktop (JVM), Web (JS & Wasm)
- **Build System**: Gradle with Kotlin DSL
- **Main Module**: composeApp

## Validation Tasks

1. Check Gradle wrapper availability
2. Verify project structure
3. Run basic build validation (if environment permits)

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

    # Run tests to ensure everything is working
    echo "Running tests..."
    ./gradlew test --console=plain || echo "⚠ Tests failed or skipped"

    # Check build
    echo "Checking build..."
    ./gradlew check --console=plain || echo "⚠ Build check failed or skipped"
  else
    echo "⚠ Gradle requires network access for first-time setup"
    echo "  Run: ./gradlew --version (when network is available)"
  fi
else
  echo "✗ Gradle wrapper not found"
  exit 1
fi

# Display available targets
echo ""
echo "📱 Available build targets:"
echo "  - Android:  ./gradlew :composeApp:assembleDebug"
echo "  - Desktop:  ./gradlew :composeApp:run"
echo "  - Web Wasm: ./gradlew :composeApp:wasmJsBrowserDevelopmentRun"
echo "  - Web JS:   ./gradlew :composeApp:jsBrowserDevelopmentRun"
echo "  - iOS:      Open iosApp directory in Xcode"
```
