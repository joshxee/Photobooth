---
name: maestro-runner
description: Run Maestro E2E flows on the connected Android device and report pass/fail + screenshot paths. Designed for delegation to a Haiku agent so the orchestrator's context stays small.
---

# maestro-runner

Run one or more Maestro flows located under `.maestro/flows/` against the connected Android device, then return a terse pass/fail summary plus screenshot paths.

## When to use

**Not on the Xiaomi development tablet.** There, Maestro's helper app triggers an "Install via USB" prompt on
every run, so it cannot run unattended. Use plain adb over Wi-Fi instead (see "Device Testing" in
`CLAUDE.md`). Use Maestro for CI and emulators/virtual devices. The Tauri flows are in `.maestro/tauri/`.

- After the orchestrator finishes a code change that affects UI/navigation.
- When verifying a fix (e.g. portrait strip layout, permission deeplink).
- When running a regression suite (`run_all.sh`).

The orchestrator should delegate this to a Haiku agent — it keeps screenshot blobs and Maestro's verbose logs out of the orchestrator's window.

## Inputs

The orchestrator should pass:

1. List of flow names to run (e.g. `nav_native_full_session.yaml`).
2. Whether to abort on first failure.
3. Whether the Sony Mark 2 camera is reachable (sets `SONY_CAMERA_AVAILABLE=1`).

If the orchestrator passes nothing, run `.maestro/run_all.sh`.

## Steps

1. Verify a device is connected: `adb devices` must show one device in `device` state. If none, report `NO_DEVICE` and exit.
2. Ensure debug build is installed: `./gradlew :composeApp:installDebug`. If it fails, report build error and exit — do not proceed.
3. For each flow:
   - `.maestro/run.sh test .maestro/flows/<flow>.yaml`
   - Capture exit code and any screenshots from `~/.maestro/tests/<latest>/screenshots/`.
4. Aggregate results.

## Output (return to orchestrator)

```
PASS  nav_settings_round_trip       (3 screenshots)
PASS  nav_native_full_session       (5 screenshots)
FAIL  regression_strip_image_visible_portrait
        - assertion: "Looking good." not visible at step 4
        - screenshot: /Users/josh/.maestro/tests/<id>/screenshots/04.png
```

Keep output ≤ 30 lines. Include screenshot paths only for failed steps unless caller asked otherwise.

## Constraints

- Never modify source code.
- Never install release builds (debug only).
- If `SONY_CAMERA_AVAILABLE` is unset, skip `nav_sony_mark2_full_session.yaml`.
- Do not run on emulator — production target is Samsung S938B (or equivalent USB-connected physical device).
- If a flow times out (>3 min), kill and mark FAIL.

## Helpful commands

```bash
# Single flow
.maestro/run.sh test .maestro/flows/nav_native_full_session.yaml

# All flows
SONY_CAMERA_AVAILABLE=0 ./.maestro/run_all.sh

# Inspect last run
ls -lt ~/.maestro/tests/ | head
```
