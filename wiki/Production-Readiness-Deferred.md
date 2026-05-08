# Production Readiness — Deferred Items

The following punch-list items were intentionally deferred from the
2026-05-08 push. Each entry records the spec, why it was deferred, and
what is needed to close it.

## PL10 — Kiosk-mode hardening on Samsung

**Spec:** Verify `kiosk/KioskModeManager` actually pins the app on Samsung
devices; document device-owner setup steps in `wiki/Kiosk-Mode.md`.

**Why deferred:** Device-owner provisioning is a one-shot operation that
requires a freshly-wiped device and an ADB command:

```bash
adb shell dpm set-device-owner com.jc.photobooth/.kiosk.KioskAdminReceiver
```

The Samsung S938B currently in use already has another device-owner set
and cannot be reprovisioned without a factory reset.

**Close criteria:** Wipe a dedicated device, provision device-owner,
exercise pin/unpin paths, and write `wiki/Kiosk-Mode.md` covering the
provisioning command, recovery from a stuck pin, and known Samsung
quirks (e.g. Knox interactions).

## PL11 — NetworkMonitor leak audit

**Spec:** `createNetworkMonitor` polls every 5 s. Audit for thread
leakage when leaving the Mark 2 screen; confirm `DisposableEffect`
`onDispose` runs `stopMonitoring()`.

**Why deferred:** The `DisposableEffect` is in place
(`SonyMark2Screen.kt:68–71`); a thorough leak audit needs a debug build
with `StrictMode` + Android Studio profiler attached, which is best done
as its own focused session.

**Close criteria:** Run a 30-minute soak test with profiler, confirm no
unbounded coroutine accumulation, document baseline thread count.

## PL12 — Release build + ProGuard/R8 keep rules

**Spec:** `./gradlew :composeApp:assembleRelease` passes; keep rules for
`KnockboxTokens`, Sony Ktor client, MediaPipe gesture detector, and
`SettingsRepository` serializers.

**Why deferred:** Requires release signing (PL13) to be in place first,
plus a methodical pass through each library's keep-rule recommendations.

**Close criteria:** `assembleRelease` produces a runnable APK; smoke
test through `nav_native_full_session.yaml` against the release build.

## PL13 — Release signing config

**Spec:** Read keystore + passwords from `local.properties` or env vars.
Document in README.

**Why deferred:** Needs a generated keystore committed (or referenced)
without leaking secrets. User has not yet supplied or generated one.

**Close criteria:** Generate `release.keystore`, store password in
`~/.gradle/gradle.properties` or `local.properties` (git-ignored), wire
`signingConfigs` in `composeApp/build.gradle.kts`, document in
`README.md`.

## PL14 — App label + Knockbox launcher icon

**Spec:** Replace stock Android launcher icon with a Knockbox-branded
adaptive icon. Update `AndroidManifest.xml android:label`.

**Why deferred:** No Knockbox brand asset has been supplied. Generating
something procedural would commit a placeholder we'd ship over.

**Close criteria:** User supplies foreground/background SVG or PNG
assets; we wire them into `composeApp/src/androidMain/res/mipmap-*` and
update the manifest label.

## PL15 — Privacy + data-handling doc

**Spec:** Document Mark 2 local-WiFi JPEG transfer in `wiki/Privacy.md`;
confirm no images leave the device.

**Why deferred:** Pure documentation work; hold until launcher/icon and
release signing land so the privacy page can also reference the user-
visible app identity.

**Close criteria:** Write `wiki/Privacy.md` describing camera→device
transfer, on-device storage location, and "no network egress" guarantee
with a code-level pointer to the Ktor client confirming the camera URL
is the only base URL.

## PL16 — GitHub Actions CI

**Spec:** Workflow that runs `:composeApp:testDebugUnitTest` and
`:composeApp:assembleDebug`; optionally upload Maestro Cloud flows.

**Why deferred:** User explicitly does not want Maestro Cloud. A
local-only CI workflow that just builds + unit-tests is a small piece
of work we can land in a follow-up.

**Close criteria:** Add `.github/workflows/ci.yml` running on `push` and
`pull_request` against `main`. No cloud upload step.

## PL17 — 50× memory test

**Spec:** Run `nav_native_full_session.yaml` 50× consecutively, watch
`dumpsys meminfo`, assert <10 MB drift.

**Why deferred:** User explicitly opted out of the memory test in
favour of keeping E2E flows short. The instinct is correct — 50 cycles
is ~12 hours of wall time and was scoped before we had a clearer view
of session length budgets.

**Close criteria:** N/A — explicitly cancelled.

## PL9 — iOS crash handler

**Spec:** iOS NSException handler writes to `filesDir/crashes/`.

**Why deferred:** Android handler is wired and tested. iOS path needs
`NSSetUncaughtExceptionHandler` + Kotlin/Native `staticCFunction` C
interop, which we have not validated against the current toolchain.

**Close criteria:** Implement on a Mac with the iOS target buildable;
verify a deliberate `NSException` writes a file under
`Documents/crashes/`; surface latest crash via the existing
`CrashLogger.lastCrash()` contract.
