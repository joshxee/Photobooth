# Claude Code Configuration

This directory contains configuration for Claude Code to help with the development and testing of the Photobooth Kotlin Multiplatform app.

## 🧪 Pragmatic Testing Philosophy

This project follows a **pragmatic testing approach** that prioritizes clean, modular, and testable code with comprehensive test coverage:

1. **Implement** - Build clean, testable components
2. **Test** - Write comprehensive tests for completed components
3. **Refactor** - Improve code quality while keeping tests green

See [TDD_GUIDELINES.md](../TDD_GUIDELINES.md) for comprehensive testing practices.

## Structure

### Subagents
Located in `.claude/subagents/`, these are specialized AI assistants with domain expertise:

- **kotlin-multiplatform.md** - Kotlin Multiplatform specialist
  - Expert in KMP architecture and best practices
  - Deep knowledge of expect/actual patterns
  - Platform-specific implementation guidance
  - Compose Multiplatform UI development
  - Cross-platform testing strategies
  - Gradle configuration for multi-target projects

### Hooks
Located in `.claude/hooks/`, these run automatically in response to events:

- **SessionStart.md** - Runs when a Claude Code session starts
  - Validates Gradle wrapper
  - **Runs all tests** to ensure green baseline (ensures nothing is broken)
  - Displays testing quick reference guide
  - Shows available build targets and test commands

### Commands
Located in `.claude/commands/`, these can be invoked with `/command-name`:

#### Development Workflow Commands
- **/tdd-red** - Implement clean, testable components
- **/tdd-green** - Write tests for implemented components
- **/tdd-refactor** - Refactor code with test safety net

#### Testing Commands
- **/test** - Run all tests across all platforms
- **/test-watch** - Run tests continuously (auto-run on changes)
- **/test-platform** - Run tests for a specific platform
- **/test-ui** - Run Compose UI tests and learn UI testing patterns

#### Build Commands
- **/build-android** - Build Android debug APK
- **/build-desktop** - Build and run desktop (JVM) application
- **/build-web** - Build and run web application (Wasm or JS)
- **/clean** - Clean build artifacts

## Usage

### Development Workflow
The recommended workflow for new features:

```
1. /tdd-red       → Implement clean, testable component
2. /tdd-green     → Write comprehensive tests
3. /test          → Verify all tests pass
4. /tdd-refactor  → Improve code quality (if needed)
5. /test          → Verify tests still pass
6. Repeat for next component!
```

### Running Commands
Type `/` in Claude Code to see available commands, or use them directly:
```
/tdd-red
/test
/test-watch
```

### Continuous Testing
For the best development experience, run tests in watch mode:
```
/test-watch
```
This auto-runs tests whenever you save a file, providing immediate feedback!

### Session Start Hook
The session start hook runs automatically and executes all tests to ensure you start with a green baseline. This can be disabled in settings if needed.

## Platform-Specific Notes

### Android
- Requires Android SDK
- Build outputs to: `composeApp/build/outputs/apk/`

### iOS
- Requires Xcode (macOS only)
- Open `iosApp` directory in Xcode

### Desktop (JVM)
- Runs on macOS, Linux, Windows
- Targets: DMG, MSI, DEB packages

### Web
- **Wasm**: Modern browsers, better performance
- **JS**: Wider browser compatibility

## Testing

### Test Structure
- **commonTest/** - Tests that run on ALL platforms (write here first!)
- **androidUnitTest/** - Android-specific tests
- **jvmTest/** - Desktop/JVM-specific tests
- **jsTest/** - Web JS-specific tests
- **wasmJsTest/** - Web Wasm-specific tests

### Test Commands
```bash
# All platforms (recommended)
./gradlew allTests

# Continuous testing (TDD best practice)
./gradlew allTests --continuous

# Specific platforms
./gradlew :composeApp:jvmTest        # Desktop
./gradlew :composeApp:jsTest         # Web JS
./gradlew :composeApp:wasmJsTest     # Web Wasm
```

## Kotlin Multiplatform Subagent

A specialized subagent is available to help with Kotlin Multiplatform development. The subagent provides:

- Guidance on expect/actual patterns for platform-specific code
- Best practices for source set organization (commonMain, androidMain, iosMain, etc.)
- Help with Compose Multiplatform UI development
- Gradle configuration assistance for multi-target projects
- Cross-platform testing strategies
- Common KMP patterns and solutions to typical issues

The subagent is automatically available when working on KMP-specific tasks and can help ensure code is properly structured for maximum code sharing across platforms.

## Learn More

- [Testing Guidelines](../TDD_GUIDELINES.md) - **Start here for testing practices!**
- [Kotlin Multiplatform Subagent](subagents/kotlin-multiplatform.md) - **KMP specialist guide**
- [Claude Code Documentation](https://docs.claude.com/claude-code)
- [Kotlin Multiplatform](https://www.jetbrains.com/help/kotlin-multiplatform-dev/get-started.html)
- [Kotlin Multiplatform Testing](https://kotlinlang.org/docs/multiplatform-run-tests.html)
- [Compose Multiplatform](https://github.com/JetBrains/compose-multiplatform)
