# Maestro flows for the Tauri app

Targets the **debug** build, whose application id is `com.jc.photobooth.tauri` (it installs next to
the existing Kotlin app). They use **Test Camera**, so they are deterministic and need no hardware.
Maestro reads the WebView's accessibility tree, so selectors are the visible strings (see
`wiki/Frontend.md`).

> **Status: written, not yet run.** The tablet was unavailable when these were written. Treat the
> first run as part of verification and fix selectors/timings as needed.

```bash
# build with the dev capability (needed only by fault_recovery.yaml) and install, then:
.maestro/run.sh test .maestro/tauri/
```

| Flow | Needs dev capability |
|------|----------------------|
| `camera_selection.yaml` | no |
| `full_session.yaml` | no |
| `settings_round_trip.yaml` | no |
| `back_button.yaml` | no |
| `fault_recovery.yaml` | **yes** (Dev panel) |

Notes: the "tap" pills fill for ~3 s before they fire, so waits after tapping are generous. A full
default session (3 shots × 3 s countdown) takes ~15 s before the strip appears; the strip returns to
attract after 12 s.
