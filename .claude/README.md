# Claude Code Configuration

This directory contains configuration for Claude Code to help with development of the Photobooth Kotlin Multiplatform app.

## Structure

### Hooks
Located in `.claude/hooks/`, these run automatically in response to events:

- **SessionStart.md** - Runs when a Claude Code session starts
  - Validates Gradle wrapper
  - Checks build environment
  - Runs tests and build validation
  - Displays available build targets

### Commands
Located in `.claude/commands/`, these can be invoked with `/command-name`:

- **/build-android** - Build Android debug APK
- **/build-desktop** - Build and run desktop (JVM) application
- **/build-web** - Build and run web application (Wasm or JS)
- **/test** - Run all tests
- **/clean** - Clean build artifacts

## Usage

### Running Commands
Type `/` in Claude Code to see available commands, or use them directly:
```
/build-android
/test
/clean
```

### Session Start Hook
The session start hook runs automatically but can be disabled in settings if needed.

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

## Learn More

- [Claude Code Documentation](https://docs.claude.com/claude-code)
- [Kotlin Multiplatform](https://www.jetbrains.com/help/kotlin-multiplatform-dev/get-started.html)
- [Compose Multiplatform](https://github.com/JetBrains/compose-multiplatform)
