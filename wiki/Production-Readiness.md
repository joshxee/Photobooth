# Production Readiness Punch List — Closeout

This page tracks the production-readiness punch list addressed in the
2026-05-08 push. Items numbered to match the original spec.

## Closed in this push

| # | Item | Where it landed |
|---|------|-----------------|
| 1 | Strip image invisible in portrait | `KnockboxStripReview.kt` — Row replaced with conditional Column (portrait) / Row (landscape); `StripCell` no longer weighted to 0.0001f |
| 2 | Knockbox-aligned Material container tokens | `PhotoboothTheme.kt` — `primaryContainer`/`secondaryContainer`/`tertiaryContainer`/`surfaceVariant` mapped to `KnockboxTokens.ForestSoft` |
| 3 | Knockbox paper-pill replacement | `KnockboxPill.kt` — new shared composable; `CameraSelectionScreen` Continue/Back/Reconnect/API-Discovery now use it. SonyApiDiscovery (dev tool, 7 buttons) intentionally untouched. Settings has no top-level action buttons; info card recoloured with Knockbox tokens |
| 4 | Mark 1 deletion | `SonyPhotoboothScreen` + `SonyPhotoboothViewModel` + `SonyCaptureState` + `SonyPhotoboothUiState` + `SonyMark1Strategy` + `PhotoboothContentStrategy` + `ui/photobooth/common/*` + `ui/photobooth/CaptureState.kt` deleted; `Screen.PHOTOBOOTH_SONY` and `CameraType.SONY_A7III` removed |
| 5 | Mark 2 connection-error UX | `SonyMark2Screen.kt` — `ConnectionErrorCard` composable with Knockbox card aesthetic + `KnockboxPill("Retry connection")` calling `viewModel.connect()` |
| 6 | Mark 2 live-preview persistence | `SonyMark2ViewModel` is hoisted in `App.kt` via `remember {}` so it survives navigation. Maestro coverage in `nav_mark2_live_preview_persistence.yaml` |
| 7 | Permission-denial deeplink | `NativePhotoboothScreen.android.kt` — `PermissionPrompt` now detects permanent denial (`shouldShowRequestPermissionRationale == false` after a request) and routes to `Settings.ACTION_APPLICATION_DETAILS_SETTINGS` |
| 8 | Settings plumb-through | `NativePhotoboothScreen.android.kt` and `SonyMark2Screen.kt` read `settingsRepository.getConfig()` via `collectAsState` and pass `numberOfPhotos`/`countdownSeconds` to `PhotoboothHost` |
| 9 | Crash logging (Android) | `util/CrashLogger.kt` (expect) + `CrashLogger.android.kt` (actual) wired in `MainActivity.onCreate`. Writes `filesDir/crashes/crash_<ts>.log` on uncaught exception. `SettingsScreen` info card shows the most recent entry |

## Maestro coverage

| Flow | Purpose |
|------|---------|
| `nav_settings_round_trip.yaml` | CameraSelection → Settings → back |
| `nav_sony_api_discovery_round_trip.yaml` | CameraSelection → SonyApiDiscovery → back |
| `nav_native_full_session.yaml` | Full Mock-camera session through to auto-restart |
| `nav_native_tap_to_start.yaml` | Tap-to-start on attract |
| `nav_native_strip_take_another.yaml` | "Take another strip →" pill restart |
| `nav_sony_mark2_no_camera.yaml` | Mark 2 with camera unreachable → ConnectionErrorCard |
| `nav_sony_mark2_full_session.yaml` | Full Mark 2 session (gated by `SONY_CAMERA_AVAILABLE=1`) |
| `nav_settings_change_persists.yaml` | Setting changes survive app relaunch |
| `nav_back_button_handling.yaml` | Hardware-back behaviour from each screen |
| `nav_kiosk_mode_locked.yaml` | Documented skip — see PL10 |
| `nav_mark2_live_preview_persistence.yaml` | 3× CameraSelection ↔ MARK2 round-trip |
| `regression_strip_image_visible_portrait.yaml` | Drives PL1 fix |

Run all with `./.maestro/run_all.sh`. Sony hardware flows skip unless
`SONY_CAMERA_AVAILABLE=1`.

## Crash logging — iOS

Android-only for this push. iOS `CrashLogger` is a no-op stub.
`NSSetUncaughtExceptionHandler` integration with Kotlin/Native
`staticCFunction` needs C-interop bridging that we have not validated
against the project toolchain. Track in
[Production-Readiness-Deferred.md](Production-Readiness-Deferred.md).

## What is *not* closed here

See [Production-Readiness-Deferred.md](Production-Readiness-Deferred.md)
for items 10–17 (kiosk verification, network leak audit, ProGuard,
release signing, launcher icon, privacy doc, CI, memory test) and the
rationale for each deferral.
