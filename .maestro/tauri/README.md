# Maestro flows for the Tauri app

Targets the **debug** build, whose application id is `com.jc.photobooth.tauri` (it installs next to
the existing Kotlin app). They use **Test Camera**, so they are deterministic and need no hardware
(the Sony can stay unplugged, so the tablet's USB connection is free for `adb`). Maestro
reads the WebView's accessibility tree, so selectors are the visible strings; a few must be
patterns (see "Accessibility and Maestro selectors" in `wiki/Frontend.md`).

> **Status: all five flows pass** on a Xiaomi Pad (Android 14, HyperOS/MIUI) with Maestro 2.11.0,
> 2026-10-09.

> **Which tool to use.** On the Xiaomi tablet used for development, **prefer plain adb for local
> testing** (`adb exec-out screencap -p`, `adb shell input tap …` / `keyevent`, `am start`,
> `uiautomator dump`, `logcat -s Photobooth`). Maestro makes the tablet show an "Install via USB"
> prompt for its helper app that must be accepted by hand on every run, so it cannot run
> unattended there. These flows are for **CI and emulators/virtual devices**, where that prompt is
> expected not to appear (not yet tried; CI does not run them yet).

```powershell
# Build with the dev capability (the default of build-android-debug.ps1; needed only by
# fault_recovery.yaml) and install, then, with adb and maestro on PATH and JAVA_HOME set:
.maestro\tauri\run.ps1                                  # all flows
.maestro\tauri\run.ps1 -Flow full_session,back_button   # a subset
```

`run.ps1` clears the app's data and starts it over adb before **every** flow; the flows attach with
`launchApp: stopApp: false` instead of relaunching. Reason: Xiaomi MIUI/HyperOS refuses to let
Maestro's driver app start an activity from the background (`Abort background activity starts` in
logcat), so a flow that begins with `stopApp` + `launchApp` ends on the home screen. Allowing
"Display pop-up windows while running in the background" for `dev.mobile.maestro` also fixes it, but
that app has no launcher icon and is not listed in Settings → Apps.

First run on a Xiaomi device: Maestro installs its helper app (`dev.mobile.maestro`) and MIUI asks
**Install via USB** on the tablet, with a 10-second auto-Deny timer. Someone has to tap *Install*
(there is a *Remember my choice* tick), otherwise it fails with
`INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`. It asked again on a later run, so be
at the tablet for the first flow of a session.

| Flow | Needs dev capability |
|------|----------------------|
| `camera_selection.yaml` | no |
| `full_session.yaml` | no |
| `settings_round_trip.yaml` | no |
| `back_button.yaml` | no |
| `fault_recovery.yaml` | **yes** (Dev panel) |

Notes: the "tap" pills fill for ~3 s before they fire, so waits after tapping are generous. A full
default session (3 shots × 3 s countdown) takes ~15 s before the strip appears; the strip returns to
attract after 12 s. `back_button.yaml` sends the Android Back key, not a tap on the on-screen
**Back** button (which `settings_round_trip.yaml` uses).
