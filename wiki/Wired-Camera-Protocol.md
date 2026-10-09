# Wired Camera Protocol (`crates/sony-ptp`)

A transport-agnostic PTP engine with Sony's SDIO extensions, for driving a Sony A7 III in
**PC Remote** USB mode. Nothing like it existed in the old KMP app (its only Sony path was
Wi-Fi JSON-RPC).

> **Verification status — first real-hardware run: 2026-10-08.** A Sony **ILCE-7M3 (firmware 4.0)**
> cabled to an Android tablet, driven through the app over the Android USB-fd path (the camera is
> not attached to the dev PC, so nothing was run from the desktop). Everything below marked
> **Verified on hardware** was observed in the device log with PTP tracing on. The first run
> *failed*, and the failure is documented honestly in "What the real camera taught us".

## Camera-side setup

Do this before connecting:

| Menu item | Value | Why |
|-----------|-------|-----|
| USB Connection | **PC Remote** | Otherwise the camera enumerates as mass storage and vendor commands stall the bulk pipe |
| Still Img. Save Dest. | **PC+Camera** | The SD card stays the archive (no app-side retention). Never "PC Only" |
| Drive Mode | Single Shooting | Continuous would keep firing if the shutter were ever held |
| Quality | JPEG or RAW+JPEG | RAW-only yields no JPEG for the strip (the engine reports this) |
| Focus | **Manual focus** on the spot where guests stand, *or* Priority Set in AF-S / AF-C = **Release** | With the default AF priority the camera does not fire when it cannot focus: it accepts every remote command and takes no picture, and the app times out with "did not deliver the photo". Menu names are as on the A7 III from memory; not checked on this body |
| Airplane Mode | On | Disables Wi-Fi |
| Power Save | Off | The camera must not sleep mid-event |

## What the engine does

```
GetDeviceInfo (txid 0)                → model, supported ops (must include SDIO_Connect)
OpenSession(1) (txid 0, then 1,2,…)
SDIO_Connect(1,0,0) → SDIO_Connect(2,0,0)
SDIO_GetExtDeviceInfo(0xC8)           → on the A7 III it simply blocks ~1 s, then answers (retried ≤ 20× if empty)
SDIO_Connect(3,0,0)                   → connected
```

**Capture:** drain stale events and any **pending objects** left in the camera → S1 down (`0xD2C1` ← `0x0002`) → ~300 ms AF settle → S2
down (`0xD2C2` ← `0x0002`) → S2 up (`0x0001`) → S1 up. Then wait for the image: an
`ObjectAdded` event (`0xC201`, param `0xFFFFC001`) **or** `ObjectInMemory` (`0xD215`) ≥
`0x8000`, whichever comes first. If neither shows within 3 s the whole press is repeated once
(longer AF pause; see finding 6). Then `GetObjectInfo(0xFFFFC001)` (retried on
`InvalidObjectHandle`/`DeviceBusy`) and a plain `GetObject(0xFFFFC001)` **whatever the size**
(chunked `SDIO_GetPartialLargeObject` stalls the A7 III's pipe, so it is opt-in — see below). A
RAW (`0xB101`) object that arrives *before* the JPEG is consumed and discarded; one that arrives
*after* it (this body's order) is left in the camera and cleared by `drain_pending` — before the
next shutter press, and by `SonyCamera` right after the JPEG arrives, before the capture returns.

**The shutter drop-guard.** S1/S2 are held by a guard whose `Drop` releases **S2 before S1**.
The "held" flag is set *before* each press is sent, so a press that errors after the camera
acted on it is still released. Tests cover: normal order, a failed S2 press, a failed S1
press, a timeout while waiting for the image, and a **panic** mid-sequence (via
`catch_unwind`) — in every case the shutter ends released and S2 is released first.

**Live view.** No start command: poll `LiveViewStatus` (`0xD221`) until non-zero, then
`GetObject(0xFFFFC002)` repeatedly. Sony's envelope is stripped by trusting a header
(`offset`,`size` as the first two LE u32s) only if it points at a well-formed JPEG, otherwise
by scanning for the first SOI and the last EOI. It is **best-effort**: `SonyCamera` runs it in
a blocking loop with a cooperative stop flag, steps aside whenever a capture is pending,
restarts via a watchdog (3 s without a frame, ≤ 3 restarts), **backs off (50 ms → 1 s) when the
camera refuses a frame with `AccessDenied`** (it does so intermittently) without ever giving
up, and ends the stream after 5 consecutive *other* failures. Capture never depends on it
(there is a test with live view permanently inactive).

## Transport layering

```
Transport (trait: write_bulk / read_bulk / read_interrupt / reset)
 ├─ RusbTransport      libusb via rusb (`rusb-transport`, alias `desktop-usb`); vendored libusb
 ├─ RecordingTransport wraps any transport, captures a JSON transcript
 ├─ ReplayTransport    strict byte-for-byte playback of a transcript
 └─ SimTransport       simulated camera for tests (`sim` feature)
```

`RusbTransport::from_handle` accepts any `rusb::DeviceHandle` — on Android the plugin builds
one from the USB file descriptor Kotlin hands over (`open_device_with_fd`), so the same engine
runs on desktop and Android. `reset()` clears the bulk endpoints' halt state instead of
resetting the device: a full USB reset could invalidate the permission-bearing fd on Android.

**Record/replay workflow** (the hardware regression suite): run `examples/shoot.rs` with
`--record session.json` against a real camera, check the transcript into the repo, and replay
it in `cargo test` with `ReplayTransport`. The test `a_recorded_session_replays_to_the_same_result_without_a_camera`
proves the loop works on a simulated session; `replay_catches_a_change_in_wire_behaviour`
proves any divergence fails loudly.

## What the real camera taught us (2026-10-08)

**Verified on hardware**

| Item | Observed |
|------|----------|
| Handshake | `GetDeviceInfo` (245 B) → `OpenSession` → `SDIO_Connect(1,0,0)` → `SDIO_Connect(2,0,0)` → `SDIO_GetExtDeviceInfo(0xC8)` (blocks ~1 s, then returns 132 B — *not* a run of empty retries) → `SDIO_Connect(3,0,0)`. Model `ILCE-7M3`, version `4.0`. |
| Stale session | `OpenSession` answers `0x201E` (SessionAlreadyOpen) if a previous app process left one open; close-and-reopen works. |
| Property dataset (`SDIO_GetAllExtDevicePropInfo`, `0x9209`) | **8-byte leading count, one value list per enumeration**, 60 records, 1.5–1.6 KB. This is now the parser's first layout; the others stay as a safety net. |
| Shutter | `SDIO_ControlDevice` `0xD2C1`/`0xD2C2` ← `0x0002`/`0x0001` accepted; S1 down → 300 ms → S2 down → S2 up (6–17 ms later) → S1 up. The camera fires. |
| Image ready | `0xC201` ObjectAdded event (param `0xFFFFC001`) arrives **~1.3 s** after the shutter; `0xC203` property-changed events stream in the meantime. `ObjectInMemory` also reads `0x8001`. |
| `GetObjectInfo(0xFFFFC001)` | Answers in ~20 ms: format `0x3801` JPEG, size ~10.9–11.1 MB, filename `C_2035xx.JPG`. **Width/height are 0**, so dimensions come from the JPEG's SOF marker (6000×4000). |
| Download | A plain `GetObject(0xFFFFC001)` of an 11 MB JPEG takes ~0.4 s. A full capture is ~2.0 s from shutter to JPEG in hand. |
| Live view | `GetObject(0xFFFFC002)` returns 46–52 KB JPEG envelopes at ~28 fps **but is refused with `0x200F` (AccessDenied) intermittently**. |

**What was wrong (found by a failed first capture)**

1. **`SDIO_GetPartialLargeObject` stalls the USB pipe.** For the 10.4 MB JPEG the engine switched to
   the chunked path (the handoff notes said ">4 MB ⇒ chunked") and sent
   `SDIO_GetPartialLargeObject [0xFFFFC001, 0, 0, 1048576]`; the camera **stalled the pipe**
   (`LIBUSB_ERROR_PIPE`) 4 ms later and the session errored with "Pipe error". Chunked download is
   now **off by default**; a plain `GetObject` is used regardless of size. (The chunked code and its
   tests remain for bodies that need it; whether the parameter shape was wrong or the command is
   simply unsupported on this body is not known.)
2. **The error said nothing useful.** "Pipe error" does not say which command. Transport errors now
   name the operation (`SDIO_GetPartialLargeObject failed: Pipe error`), a stall is a distinct
   `Error::Stall`, and the engine **clears the endpoint halt** afterwards (a halted endpoint refuses
   all later traffic).
3. **Live view was handled wrongly twice.** First, a successful *activation* reset the failure
   counter, so a camera that reports live view "on" but refuses frames was hammered forever (82
   requests in 25 s). Then my fix treated `AccessDenied` as permanent, which killed the stream after
   five frames — the user saw a **frozen preview**. It is now treated as transient: back off
   (50 ms → 1 s) and resume when frames flow.
4. **RAW+JPEG leaves the RAW behind.** This body delivers the **JPEG first, then the ~49 MB ARW**.
   Returning on the JPEG left the ARW queued, so the *next* capture downloaded and discarded it first
   (+1.7 s) — and a photo left behind by any failed capture could have been returned as the *next*
   shot. The engine now drains any pending objects before pressing the shutter (one property read
   when nothing is pending) and `SonyCamera` clears the RAW companion before the capture returns.
   A first version did that in a background task; the second 3-shot run on the tablet showed why
   that is wrong: the ~2.3 s download holds the camera, so the live preview froze for the first two
   seconds of every following countdown (gaps of 3.4–4.4 s in the frame log). Doing it inside the
   capture trades that for a longer "capturing" phase and keeps the countdown preview live and the
   shutter on time.
5. **A misleading hint.** A photo that never arrived was reported as "camera not in PC Remote mode?",
   although the handshake had just succeeded. It now says the camera did not deliver the photo and to
   check focus and *Still Img. Save Dest.* An earlier attempt hit exactly this timeout (identical
   shutter sequence, no `ObjectAdded` event); the cause was **not established** at the time.
6. **A shot that never fires (2026-10-09, second occurrence).** After an unplug/replug, one shot in
   a session produced no image for the full 10 s while the three before it took ~1.1 s each. The
   events show a focus-related property change (`0xD213`) arriving ~480 ms after the half-press, *after*
   our 300 ms settle had already tapped S2 and released both buttons; the successful shots show no
   such event. Reading: with focus priority the camera drops a full press that lands before
   autofocus has locked, and the quick tap (S2 up immediately) leaves nothing to fire later. This
   fits both occurrences but is **still an inference** (the property's meaning is unverified; no
   PTP trace was running). So the engine now repeats the press **once** if no image shows within
   3 s (`retry_after`), with a 1.2 s autofocus pause (`retry_af_settle`); nothing was taken, so it
   cannot duplicate a photo. If the second try also fails, the error is unchanged. On a timeout the
   log now lists the camera's last events. Holding S2 until the image arrives was rejected: in a
   continuous drive mode it would keep firing.

   **Third occurrence, and the repeat did not help.** On the next test (no unplug yet; shots 1–2
   fine at ~1.1 s) shot 3 got no image, the automatic repeat got none either, and the user saw
   that the shutter never fired. This time the failed attempt showed *no* `0xD213` event at all
   (only `0xD21D` property changes, and none of the `0x5004` that precedes the image in good
   shots), so the focus-event reading above does **not** fit every case, and a longer autofocus
   pause is not a fix. What is known: the camera accepted every control command without error and
   simply did not fire. What is not: why. Candidates are autofocus failing on whatever was in
   front of the lens (a person moving, the cable being handled), a camera-side state, or the
   quick S2 tap. To settle it, the engine now logs the camera's **whole property set** before every
   shot (`camera state before the shot`, debug) and again on each timeout (`state=` in the warning,
   `code=value` in hex) so a failed shot can be diffed against a good one.

   **Fourth round (the user deliberately aimed the camera where it could not focus): five of five
   failures, and the automatic repeat rescued none of them.** The user's reading is that the
   camera could not focus in time, and everything fits it: commands accepted, no exposure, no
   difference in the camera's state. The property diff cannot confirm it, though: across three
   failed and two good shots, the 60 properties read *after* the half-press was released are
   identical except `5007` (FNumber), so no focus state survives release. Hence a further snapshot
   is taken with the shutter **half-pressed**, just before the full press
   (`camera state with the shutter half-pressed`). If a property differs there between a
   focusable and an unfocusable scene, the engine can wait for it, fail in ~1–2 s with "could not
   focus" instead of ~10 s, and stop guessing. Until then the remedy is on the camera (see
   "Camera-side setup": manual focus, or release priority).
7. **Live view died quietly.** The live-view loop gives up after five consecutive failures
   (an unplug), but it did not update the camera's status: it kept saying `Ready`, so no error was
   shown, `connect()` (a no-op for a Ready camera) could not rebuild it, and after a manual
   reconnect nothing asked the camera for frames again. Now the loop marks the camera `Error`
   when it gives up, and `AppState` resumes live view into the same channel once the camera has left
   `Ready` and come back. An unplugged camera is reported as "camera disconnected" instead of the
   raw libusb text.

**Still unverified**

- Live-view stability over minutes (the refusal pattern is intermittent and not understood);
  `ObjectInMemory` semantics beyond what the event path showed.
- RAW-only quality, other firmware, and `SDIO_OpenSession (0x9210)` (not needed on this body).
- Whether a blind 300 ms AF settle (plus the one repeat) is enough in dim light; a
  focus-confirmation property would be better, but the meaning of `0xD213` has not been verified.

## Diagnosing on the device

`adb logcat -s Photobooth` shows the app's log. For the full PTP conversation (every command and
response) create a flag file and restart the app:

```bash
adb shell run-as com.jc.photobooth.tauri touch debug-ptp   # trace on
adb shell run-as com.jc.photobooth.tauri rm debug-ptp      # trace off
```

Tracing at live-view rates overruns logcat's small ring buffer; read the log right after the event.
Capture milestones (`shutter released`, `image ready`, `downloading the captured object`,
`capture complete`) are at INFO and always on.

## On-device checklist (camera on the tablet)

Run once the Android build exists (see `Native-Camera-Plugin.md` and `Tauri-App.md`):

Status as of the first hardware run (2026-10-08); ✅ = observed in the device log, ⬜ = not yet run.

- ✅ Camera menu set per the table above; camera cabled to the tablet.
- ✅ The app's USB-permission dialog appears and is accepted.
- ✅ `GetDeviceInfo` returns `ILCE-7M3`; the handshake completes.
- ✅ A capture produces a 6000×4000 JPEG (11 MB) in ~2 s (after the chunked-download fix).
- ✅ Property-dataset layout recorded: 8-byte count, one value list per enumeration.
- ✅ Shutter is released after every capture.
- ⬜ The SD card also holds the picture (Still Img. Save Dest. = PC+Camera).
- ✅ Three consecutive RAW+JPEG captures (1.9–2.0 s each, 6000×4000) with the RAW discarded each time; live view ran at ~20 fps with ~19 % of frames refused (`AccessDenied`) and no gap over 0.11 s outside a capture.
- ✅ A full 3-shot RAW+JPEG session on the latest build (RAW cleared inside the capture): the preview stayed live through every countdown and the strip showed all three photos (user-observed).
- ◐ Unplug while idle: live view gave up after five `No such device` failures (~0.5 s). **The
  camera status did not change** (an earlier version of this page wrongly said it went to the error
  state), so no banner appeared and nothing could recover it. Fixed 2026-10-09, see below; the fix
  is covered by a simulator test but not yet re-run on the tablet.
- ✅ Unplug mid-countdown → replug → *Try again* (2026-10-09, build of `4a6894c`, from the device
  log): shot 1 captured at 17:29:02; the cable was pulled ~2 s later. Live view gave up after five
  `No such device` failures in 0.4 s, the session reported `camera disconnected recoverable=true`
  (status went to `Error`). *Try again* 6 s later: `CloseSession` on the dead transport failed
  and was ignored, the camera was found again, `live view resumed` 1 s after that. The new session
  captured three shots (1.8–1.9 s each, no timeout, no shutter repeat needed) and the booth ended
  on the attract screen with the preview live. Earlier failures (dead preview, timed-out shot) did
  not recur. Not verified from the log: what the banner said during the outage.
- ✅ Wrong mode (USB Connection = Mass Storage, 2026-10-09): connecting fails at once (the USB
  device has no still-image interface), the banner mentions PC Remote with *Retry connection*, and
  the start pill is disabled. The first run showed the text prefixed "malformed PTP data:", which
  is wrong (nothing was malformed); it is now its own error, `WrongUsbMode`, shown without the
  prefix. The failure also left no line in the log; `connect_camera` now logs `connect failed`.
  Re-run on the tablet after the fix: the banner now reads "USB device has no still-image interface
  with bulk in/out and interrupt endpoints; is the camera in PC Remote mode?" and logcat has
  `connect failed ... err=camera I/O error: USB device has no still-image interface ...` (on
  Android the open fails in the plugin's `establish`, which wraps it as `CameraError::Io`, so the
  log label says I/O although the cause is the USB mode).
- ⬜ Live view for 30+ s without freezing; a capture still works while it is refusing frames.
- ✅ JPEG-only quality (camera set to Extra fine, 2026-10-09): four captures, each one 10–13 MB
  6000×4000 JPEG, no RAW object, 1.8–1.9 s end to end (vs ~2.3 s with the RAW companion). An
  unplug/replug mid-session was handled the same way.
- ⬜ Record a real-session transcript and commit it as a replay fixture (needs the desktop `shoot`
  example or an on-device recorder; the Android path has no recorder yet).

## Known limitations

- **Cancelling a capture can orphan a hardware operation** (see `Core-Domain.md`): the async
  future is dropped but the blocking thread finishes the PTP exchange; the next operation
  queues behind it on the engine mutex.
- **Desktop USB on Windows** needs a WinUSB driver bound to the camera (e.g. Zadig); the
  `desktop-usb` feature is compile- and unit-tested here but not exercised.
- **One camera, one session.** Hot-swapping cameras mid-session is out of scope.
- **Strip photos used to take ~0.5 s to appear** because the full 6000×4000 JPEG (~10 MB) was
  fetched and decoded three times when the strip mounted. The booth now prepares each photo during
  the next countdown, so the first two show instantly; the last one still takes ~0.2 s. See
  "Strip photos" in `Frontend.md`.
- **RAW+JPEG makes each capture slower on the wire** (the ~49 MB RAW is downloaded and discarded
  inside the capture, ~2.3 s). JPEG-only quality avoids it; whether to keep RAW on the SD card is a
  camera-menu choice the app cannot influence.
- **No coverage percentage is claimed.** 87 `sony-ptp` tests (63 without the `core-camera`
  adapter), all against the simulator or recorded transcripts — the hardware findings above were
  observed by hand, not by an automated test.
