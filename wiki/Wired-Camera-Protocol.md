# Wired Camera Protocol (`crates/sony-ptp`)

A transport-agnostic PTP engine with Sony's SDIO extensions, for driving a Sony A7 III in
**PC Remote** USB mode. Nothing like it existed in the old KMP app (its only Sony path was
Wi-Fi JSON-RPC).

> **Verification status — read this first.** In the session that wrote this page the camera
> was cabled to the *tablet*, not the development machine, and no Android SDK was available
> to run the app there. So **nothing on this page has been exercised against a real A7 III
> yet.** What *is* verified: the engine is self-consistent, byte-correct on the framing it
> defines, and robust to the failure modes listed below — against a byte-level simulated
> camera (`sim.rs`) that encodes the protocol facts the task handed us. The protocol facts
> themselves are taken from libgphoto2 and public reverse-engineering notes (Sony has not
> published the protocol). Treat the **"Unverified assumptions"** section as the checklist
> for the first real-hardware run.

## Camera-side setup

Do this before connecting:

| Menu item | Value | Why |
|-----------|-------|-----|
| USB Connection | **PC Remote** | Otherwise the camera enumerates as mass storage and vendor commands stall the bulk pipe |
| Still Img. Save Dest. | **PC+Camera** | The SD card stays the archive (no app-side retention). Never "PC Only" |
| Drive Mode | Single Shooting | Continuous would keep firing if the shutter were ever held |
| Quality | JPEG or RAW+JPEG | RAW-only yields no JPEG for the strip (the engine reports this) |
| Airplane Mode | On | Disables Wi-Fi |
| Power Save | Off | The camera must not sleep mid-event |

## What the engine does

```
GetDeviceInfo (txid 0)                → model, supported ops (must include SDIO_Connect)
OpenSession(1) (txid 0, then 1,2,…)
SDIO_Connect(1,0,0) → SDIO_Connect(2,0,0)
SDIO_GetExtDeviceInfo(0xC8)           → retried (≤ 20×) while the answer is empty; normal
SDIO_Connect(3,0,0)                   → connected
```

**Capture:** drain stale events → S1 down (`0xD2C1` ← `0x0002`) → ~300 ms AF settle → S2
down (`0xD2C2` ← `0x0002`) → S2 up (`0x0001`) → S1 up. Then wait for the image: an
`ObjectAdded` event (`0xC201`, param `0xFFFFC001`) **or** `ObjectInMemory` (`0xD215`) ≥
`0x8000`, whichever comes first. Then `GetObjectInfo(0xFFFFC001)` (retried on
`InvalidObjectHandle`/`DeviceBusy`) and `GetObject(0xFFFFC001)`; objects larger than 4 MiB use
`SDIO_GetPartialLargeObject(handle, offset_lo, offset_hi, len)` in 1 MiB chunks, falling
back to `GetObject` if the camera refuses. A RAW (`0xB101`) object is consumed and discarded,
and the loop continues until a JPEG arrives (≤ 4 objects).

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
restarts via a watchdog (3 s without a frame, ≤ 3 restarts), and ends the stream after 5
consecutive failures. Capture never depends on it (there is a test with live view
permanently inactive).

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

## Unverified assumptions (resolve on the first real run)

Each is isolated so a wrong guess is a one-line fix, and each has a graceful fallback.

1. **Property reads.** `SDIO_GetAllExtDevicePropInfo` (`0x9209`) is believed to return a
   dataset of property records. The parser tries four layouts (with/without an 8-byte leading
   count; one or two value lists in enumeration forms) and accepts only one that consumes the
   buffer exactly; on failure it falls back to plain `GetDevicePropValue (0x1015)`. The layout
   that works is logged at `debug` level (`parsed extended property info`) — **record it here**.
2. **`SDIO_Connect` parameters.** Sent as `(phase, 0, 0)`. Older bodies needed key exchange;
   the A7 III is believed not to.
3. **`SDIO_GetExtDeviceInfo` param `0xC8`** and "empty ⇒ retry" semantics.
4. **Event delivery.** Whether `ObjectAdded (0xC201)` actually arrives on the interrupt
   endpoint for this body. If not, polling `0xD215` is sufficient — both paths are covered.
5. **Live-view envelope.** The `(offset, size)` header guess; the scan fallback does not
   depend on it.
6. **RAW+JPEG handling.** That the RAW must be *downloaded* (not just skipped) to advance the
   buffer, and that the JPEG then appears at the same `0xFFFFC001` handle.
7. **Large JPEGs.** A 24 MP JPEG may exceed 4 MiB; the chunked path (offset split low word
   first) is untested against the camera.
8. **`SDIO_OpenSession (0x9210)`** is defined but not used; newer bodies need it, the A7 III
   is believed not to.
9. **Timeouts.** Defaults are 5 s command / 15 s data per transfer; real-world values unknown.

## On-device checklist (camera on the tablet)

Run once the Android build exists (see `Native-Camera-Plugin.md` and `Tauri-App.md`):

- [ ] Camera menu set per the table above; cable the camera to the tablet.
- [ ] The app's USB-permission dialog appears; accept it.
- [ ] `GetDeviceInfo` returns the model (`ILCE-7M3`) and lists `0x9201` among operations.
- [ ] Handshake completes; note how many `GetExtDeviceInfo` retries it took.
- [ ] A capture produces a JPEG; the SD card also has the picture.
- [ ] Record the property-dataset layout from the debug log (assumption 1).
- [ ] Shutter released after every capture (camera does not keep firing).
- [ ] Unplug mid-countdown: session shows a recoverable error, not a hang.
- [ ] Wrong mode (USB Connection = Mass Storage): error mentions PC Remote.
- [ ] Live view: frames for at least 30 s; note any freeze (known issue on A7-generation
      bodies); confirm a capture still works while frozen.
- [ ] RAW+JPEG quality: only the JPEG reaches the strip.
- [ ] Capture a transcript with `--record` equivalent and commit it as a replay fixture.

## Known limitations

- **Cancelling a capture can orphan a hardware operation** (see `Core-Domain.md`): the async
  future is dropped but the blocking thread finishes the PTP exchange; the next operation
  queues behind it on the engine mutex.
- **Desktop USB on Windows** needs a WinUSB driver bound to the camera (e.g. Zadig); the
  `desktop-usb` feature is compile- and unit-tested here but not exercised.
- **One camera, one session.** Hot-swapping cameras mid-session is out of scope.
- **No coverage percentage is claimed.** 66 tests (54 without the `core-camera` adapter).
