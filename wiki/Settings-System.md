# Settings System

## Overview

The settings system allows users to configure photobooth behavior including the number of photos captured and countdown duration. Settings persist across app sessions using AndroidX DataStore.

## Architecture

### Components

1. **SettingsRepository** (`data/SettingsRepository.kt`)
   - Manages persistence of `PhotoboothConfig` using DataStore
   - Provides reactive Flow of settings changes
   - Shared with `CameraRepository` using the same DataStore instance

2. **SettingsScreen** (`ui/settings/SettingsScreen.kt`)
   - Material3 UI for adjusting settings
   - Real-time preview of configuration
   - Auto-saves changes using sliders (1-10 range)

3. **PhotoboothConfig** (`model/PhotoboothConfig.kt`)
   - Data class with validation
   - `numberOfPhotos`: Photos per session (min: 1)
   - `countdownSeconds`: Countdown duration (min: 1)

### Data Flow

```
User adjusts slider
  ↓
SettingsRepository.saveConfig()
  ↓
DataStore persists to disk
  ↓
PhotoboothViewModel observes via Flow
  ↓
Photobooth uses updated config
```

## Implementation Details

### Persistence

Settings are stored using DataStore Preferences with these keys:
- `number_of_photos`: Integer preference
- `countdown_seconds`: Integer preference

**Default values:** 3 photos, 3 second countdown

### ViewModel Integration

`PhotoboothScreenWrapper` loads settings on initialization:

```kotlin
LaunchedEffect(Unit) {
    settingsRepository.getConfig().collect { loadedConfig ->
        config = loadedConfig
    }
}
```

The ViewModel is recreated when config changes (using `viewModel(key = config.toString())`) to apply new settings immediately.

### Navigation

Settings icon appears on:
- Welcome screen (top right)
- Camera selection screen (top right)
- Photobooth screen (top right)

All navigate to `Screen.SETTINGS` which shows `SettingsScreen` with back navigation.

## Design Decisions

### Why DataStore over SharedPreferences?

- **Type safety**: Preferences API provides type-safe keys
- **Coroutine support**: Native Flow integration for reactive updates
- **Modern Android**: Recommended by Google for new apps
- **Cross-platform**: Works with Kotlin Multiplatform

### Why Real-time Saving?

Settings save immediately on slider change rather than requiring explicit "Save" button because:
- **Fewer interactions**: More intuitive mobile UX
- **No lost changes**: Can't forget to save
- **Instant feedback**: Summary card updates live

### Why Shared DataStore Instance?

The same DataStore instance is shared between `SettingsRepository` and `CameraRepository` because:
- **Resource efficiency**: Single file, single coroutine scope
- **Atomic operations**: No conflicts between repositories
- **Simpler architecture**: One source of truth

### Why Recreate ViewModel on Config Change?

Using `viewModel(key = config.toString())` forces recreation when settings change because:
- **Immediate effect**: New capture sessions use latest settings
- **Predictable behavior**: Clear when changes apply
- **Simple implementation**: No complex state synchronization needed

However, this means:
- **Permission state reset**: User may need to re-grant camera permission
- **Trade-off accepted**: Settings change is infrequent, predictability more important

## Limitations

1. **Settings don't update mid-capture**: If user changes settings during countdown, current session continues with old values
   - **Rationale**: Changing photo count mid-capture would cause confusing UX
   - **Future**: Could show warning if settings changed during active session

2. **No validation feedback in UI**: Sliders constrained to valid range (1-10), but no explicit error messages
   - **Rationale**: Impossible to enter invalid values with sliders
   - **Future**: If text input added, would need validation messages

3. **Desktop/Web not supported**: Settings work but photobooth itself isn't implemented on these platforms
   - **Rationale**: Camera APIs differ significantly across platforms
   - **Status**: Android only for MVP

## Testing

Settings are tested through manual end-to-end testing rather than unit tests because:
- DataStore requires coroutine scope and file I/O setup
- Integration testing verifies real persistence behavior
- UI testing confirms settings actually affect photobooth

**Test checklist:**
- [ ] Settings persist after app restart
- [ ] Changing photo count affects next capture session
- [ ] Changing countdown affects next capture session
- [ ] Settings accessible from all three screens
- [ ] Back navigation returns to previous screen

## Future Enhancements

Potential improvements for future iterations:

1. **Photo quality settings**: Allow users to choose JPEG quality/resolution
2. **Flash mode**: Toggle flash on/off for captures
3. **Sound effects**: Enable/disable shutter sound
4. **Preview duration**: How long to show each photo before next countdown
5. **Export settings**: Save/load configurations as presets
6. **Reset to defaults**: Button to restore original settings

## Related Documentation

- [Architecture.md](Architecture.md) - Overall app architecture
- [State-Management.md](State-Management.md) - ViewModel patterns
- [Testing-Strategy.md](Testing-Strategy.md) - Test approach
