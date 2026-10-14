# Native Camera Plugin (`plugins/tauri-plugin-photobooth-camera`)

One Tauri plugin for everything that needs Android: the **device camera** (CameraX), the
**USB host** for the wired Sony, and a few window behaviours. Rust drives it; the WebView can
reach only the window helpers and the event-listener table.

> **Verification status.** The Rust side (36 tests, clippy `-D warnings` clean) and the
> TypeScript API are verified on the dev machine. The **Kotlin has not been compiled or run**:
> the build host had no Android SDK/NDK and no tablet was reachable. Treat the Kotlin and the
> on-device checklist below as unproven until that is done.

## Shape

```
Kotlin PhotoboothCameraPlugin          Rust (this crate)
  usbList / usbRequestPermission  ◄──  PhotoboothCamera<R>  (typed async calls, mobile.rs)
  usbOpen  / usbClose             ◄──    ├─ UsbBackend  ──► UsbSonyCamera  (feature sony-transport)
  camStartPreview / camStopPreview◄──    └─ NativeBackend ► NativeCamera   (feature core-camera)
  camCapture                      ◄──
  checkPermissions/requestPermissions
  windowSetKeepScreenOn/Immersive ◄──  WebView-callable commands (build.rs COMMANDS list)
  registerListener/removeListener ◄──    + register_listener / remove_listener forwarding
  events → trigger(): usbAttached, usbDetached, backPressed
```

`NativeCamera` and `UsbSonyCamera` are written against small traits (`NativeBackend`,
`UsbBackend`, `TransportFactory`), so permission flows, capture-file handling and teardown
ordering are unit-tested with fakes — the real `PhotoboothCamera<R>` just implements the traits.

**Least privilege.** `build.rs` lists only four commands for the WebView
(`window_set_keep_screen_on`, `window_set_immersive`, `register_listener`, `remove_listener`).
`usb*` and `cam*` are reachable from Rust only. On non-Android targets every native call returns
`Error::Unsupported`, and the plugin still registers so the capability file is identical on every
platform.

## Why CameraX behind a transparent WebView (not `getUserMedia`)

- **Capture quality and EXIF stay under native control.** `ImageCapture` with
  `CAPTURE_MODE_MINIMIZE_LATENCY` writes a full-resolution JPEG with correct EXIF orientation;
  `getUserMedia` gives a video frame grab at whatever the WebView negotiates.
- **The camera stays in the trusted process.** The WebView never holds a camera stream, only
  the UI on top of it. A compromised page cannot read frames.
- **No IPC for the preview.** The preview is drawn natively, so `NativeCamera::start_live_view`
  returns an *empty* frame stream; nothing travels over IPC while the guest looks at themselves.
- It is the pattern Tauri's official `barcode-scanner` plugin uses. The `PreviewView` is added to
  the WebView's parent at index 0 (behind it), the WebView is made transparent and brought to the
  front, and `COMPATIBLE` (TextureView) mode is used because it composites correctly under a
  transparent view.

Captures are written to `cacheDir` and returned as `{path, width, height}`; Rust reads the JPEG
and **deletes the file** (`read_and_delete`), even if the read fails. Photos are therefore never
retained on the device and raw bytes never go through JSON IPC.

## The USB file-descriptor contract

`usbOpen` returns a `dup()` of the descriptor inside Kotlin's `UsbDeviceConnection`
(`ParcelFileDescriptor.fromFd`). Kotlin keeps ownership and closes the dup in `usbClose`.

1. libusb's `open_device_with_fd` does **not** take ownership of the fd.
2. The USB permission grant lives on the Kotlin `UsbDeviceConnection` object, **not** on the fd
   number. If Kotlin closes its connection while Rust's transport is alive, later libusb calls
   fail even though the integer is still an open fd.
3. Therefore the order is always: build the transport → use it → **drop the transport** → only
   then `usbClose`.

This is enforced by `UsbSonyCamera`, not left to callers, on **every** path: normal disconnect,
handshake failure (camera in the wrong mode), transport-factory failure, and rebuild after a
wedged pipe. `SonyCamera::release()` (in `sony-ptp`) drops the engine and its transport
deterministically even if other clones of the camera's internals are still alive. The tests
`disconnect_drops_the_transport_before_closing_the_usb_connection` and
`the_same_order_holds_when_the_handshake_fails` assert it with a transport that logs its own drop.

Three `rusb` facts, verified against its source, that `AndroidUsbTransport::from_fd` relies on:

1. There is no `UsbOption::no_device_discovery()`. The real API is the free function
   `rusb::disable_device_discovery()`, which **must run before `Context::new()`** (done once per
   process; Android apps cannot enumerate USB through libusb).
2. `open_device_with_fd` is a method of the `UsbContext` trait, is `unsafe`, and is `#[cfg(unix)]`
   in `rusb`; a `#[cfg(not(unix))]` stub keeps the crate compiling on Windows.
3. The fd is a dup that libusb does not own (above).

## Kotlin behaviours worth knowing

- **Back button.** `Plugin` has no back-press hook, so the plugin registers an
  `OnBackPressedCallback` on the activity's dispatcher and forwards `trigger("backPressed")`;
  the UI uses it to leave the booth instead of closing the app.
- **USB permission** uses a `PendingIntent` that is `FLAG_MUTABLE` (Android fills in extras) and
  explicit via `setPackage` (a mutable implicit PendingIntent throws from API 34). The receiver is
  registered `RECEIVER_NOT_EXPORTED` and also relays `USB_DEVICE_ATTACHED/DETACHED` for Sony
  devices as `usbAttached`/`usbDetached`.
- **Mirroring.** `PreviewView` already mirrors a front camera, so the plugin flips only when the
  requested mirroring differs from that natural state. Captures are never mirrored.
- **Gesture detection** (`gestureDetect`, Rust-only like `usb*`/`cam*`): Rust sends one live-view
  JPEG as base64 plus the box; `PalmFinder` crops the box **plus 50 % margin** (a hand pushed at
  the camera is bigger than the box, and a hand cut off at the crop edge is not found), runs
  MediaPipe's `GestureRecognizer` (4 hands) and returns the largest *open hand* whose centre is in
  the box, as a frame-fraction rectangle. A palm is **only** what MediaPipe labels `Open_Palm`: a
  looser rule (any hand with 4+ fingers extended by the landmarks) was tried and started sessions
  from the back of a hand or a hand hanging at the guest's side, so it was removed. The finger
  count is still logged (`fingers=`) to see what the classifier is deciding. Deliberately eager: **IMAGE mode** (every frame detected from scratch,
  because the video/live-stream modes track the hands they found first and stick to them, which
  is what stopped the old app starting), 2 hands, thresholds 0.3, one executor thread.
  `gesture_recognizer.task` (8 MB) and `tasks-vision:0.10.14` are the old app's. **Verified on the
  tablet with the Sony (2026-10-09):** frames are 1024×680; the box maps to the right place (the
  saved crop matches the box on screen); a real raised hand was recognised and started real
  captures; ~12 detections/s at 40–90 ms each; with a hand in view about half the frames hit
  (so the 500 ms gap tolerance matters). **Weak spot:** a hand close to the lens is out of focus on
  the Sony's live view and the recogniser misses blurred hands. One log line a second
  (`PhotoboothCamera: gesture: last second calls= withHands= palms= | …`); to also keep the last
  frame and crop for inspection, `adb shell run-as com.jc.photobooth.tauri mkdir cache/gesture-debug`
  and pull `cache/gesture-debug/{frame,crop}.jpg` (live-view frames of guests: debug only).
- **Immersive mode / keep-awake** use `WindowInsetsControllerCompat` and `FLAG_KEEP_SCREEN_ON`.

## Why not `getUserMedia`/other designs — and what was rejected

- *Streaming the camera preview through IPC:* rejected; avoidable bandwidth and latency for a
  preview that only the native layer needs.
- *Exposing `usb*`/`cam*` to the WebView:* rejected; the page should not be able to open the
  camera or a USB device.
- *Listening to `usbAttached` in Rust to build the Sony camera eagerly:* rejected for now. The
  camera is built **lazily on `connect()`** and `camera_list` polls `usbList`; this removes a
  Kotlin→Rust event channel and the lifecycle bugs that come with it.

## On-device checklist (tablet)

Needs an Android build (see `Android-Build.md`) and the tablet:

Xiaomi Pad, Android 14 (HyperOS/MIUI), 2026-10-09. ✅ = observed, ⬜ = not yet.

- ✅ First launch: the CAMERA permission prompt appears when the Device Camera is connected.
  ✅ Denying it (permission revoked and marked user-fixed over adb, so no dialog) shows
  "Camera permission was denied. Allow it in Settings → Apps → Photobooth → Permissions." in the
  banner with *Retry connection*; no crash. (The duplicate red toast and the still-active *Tap to
  start* pill were fixed afterwards: one message now, pill disabled. Re-checked on the tablet.)
- ✅ **Preview visible under the React overlay** on the attract screen; the "Tap to start" pill
  and text stay legible; the strip-review screen (opaque) covers it.
- ✅ Rotating the device with the app running works (user-observed). ⬜ Mirror on/off in Settings
  flipping the preview, and portrait-vs-landscape preview orientation specifically, were not
  checked separately.
- ✅ A capture produces a JPEG; **no `photobooth-*.jpg` remains in the app's cache dir**
  afterwards (`adb shell run-as com.jc.photobooth.tauri ls cache`).
- ✅ Hardware Back from the booth returns to the camera picker (Maestro `back_button.yaml`
  sends the Back key). The immersive mode hides the navigation bar, so on the tablet Back is only
  reachable by swiping up from the bottom edge: by design for a kiosk.
- ◐ Plugging the Sony in showed the **USB permission dialog** once; it has not reappeared
  reliably since. Nothing depends on it: the app polls `usbList` and requests permission itself
  (that path worked on the real camera), so the attach intent only adds auto-launch and a
  remembered grant. Android does not re-prompt once "Always" was chosen or when the app is already in
  front, which would explain the "flaky" impression; not confirmed with a log.
- ✅ fd handoff: the Sony handshake completes and `GetDeviceInfo` reports `ILCE-7M3`
  (see `Wired-Camera-Protocol.md`).
- ✅ Unplugging the camera: live view gives up after five `No such device` failures, the status
  goes to `Error`, and `AppState` resumes live view once the camera is back. Re-run on the tablet
  2026-10-09 (unplug mid-countdown → replug → *Try again*): the preview resumed and the next
  three shots succeeded. See `Wired-Camera-Protocol.md`.
- ✅ Background (Home key, 8 s) and foreground with the preview running, for both the Device
  Camera (preview live again, different scene) and the Test Camera (frames keep streaming: the
  colour advanced between screenshots; process alive, no crash). Backgrounding *during* a session
  was not tried.

## Known limitations

- The Kotlin plugin compiles and runs on a Xiaomi Pad (Android 14, HyperOS); other devices and
  Android versions are untested.
- `windowed` in `camStartPreview` is accepted but not implemented (fullscreen only).
- Only one CameraX preview at a time; the front camera is always used by `NativeCamera`.
- The plugin's `guest-js` is a typed reference API; the app keeps its own thin copy in
  `apps/booth/src/platform.ts` to avoid a cross-package install dependency, so the two must be
  kept in step.
- The WebView background is left transparent after a preview stops; the page paints its own
  background so this is invisible, but a blank page would show the window background.
