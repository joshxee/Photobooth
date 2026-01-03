# Camera System

## Overview

The photobooth app supports **dual camera modes** with a unified camera selection interface:

1. **Native Device Camera** - Built-in camera using CameraX (Android), AVFoundation (iOS), etc.
   - Full photobooth experience with countdown timer
   - 4-photo strip generation
   - Platform-specific implementations using expect/actual pattern

2. **Sony A7 III** - External mirrorless camera via WiFi using Sony's Camera Remote API
   - Professional camera quality
   - Live view preview
   - Single photo capture (Mark 1.0 - SD card workflow)
   - WiFi-based remote control

Users can choose their preferred camera mode at runtime via the Camera Selection screen, and the selection persists across app launches using DataStore.

---

## Native Device Camera Implementation

### Android Implementation (CameraX)

**File:** `composeApp/src/androidMain/kotlin/com/jc/photobooth/camera/CameraController.android.kt`

### Key Design Decisions

#### 1. Front Camera by Default

```kotlin
val cameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA
```

**Decision:** Use front-facing camera for photobooth experience.

**Reasoning:** Users expect to see themselves when taking selfies in a photobooth.

**Future:** Could add camera toggle option in settings.

---

#### 2. Suspend Function for Photo Capture

**Critical Decision:** `capturePhoto()` is a `suspend fun`, not a blocking function.

**Original Implementation (BROKEN):**
```kotlin
// ❌ DEADLOCK - Don't do this!
override fun capturePhoto(): PhotoData {
    imageCapture.takePicture(executor, callback)

    // Blocks main thread while waiting for callback
    while (photoData == null && error == null) {
        Thread.sleep(100)  // ❌ Blocks the same thread callback needs!
    }
    return photoData
}
```

**Problem:** The callback runs on `executor` (main thread), but the while loop also blocks the main thread, creating a deadlock.

**Fixed Implementation:**
```kotlin
// ✅ Proper async with coroutines
override suspend fun capturePhoto(): PhotoData {
    return suspendCancellableCoroutine { continuation ->
        imageCapture.takePicture(executor, callback) {
            // Callback resumes the suspended coroutine
            continuation.resume(photoData)
        }
    }
}
```

**Why This Works:**
- `suspendCancellableCoroutine` suspends the coroutine WITHOUT blocking the thread
- Main thread remains free to execute the camera callback
- Callback resumes the coroutine when photo is ready
- No deadlock, no polling, cleaner code

**Lesson:** When integrating callback-based APIs (like CameraX) with coroutines, always use `suspendCancellableCoroutine`, never block with `Thread.sleep()`.

---

#### 3. Image Format Conversion

**Challenge:** CameraX's `ImageProxy` provides raw YUV image data, not JPEG.

**Decision:** Convert YUV to JPEG on capture.

**Implementation:**
```kotlin
private fun imageProxyToJpegBytes(image: ImageProxy): ByteArray {
    return when (image.format) {
        ImageFormat.JPEG -> {
            // Already JPEG, extract directly
            val buffer = image.planes[0].buffer
            ByteArray(buffer.remaining()).apply { buffer.get(this) }
        }
        else -> {
            // Convert YUV to JPEG
            val yuvImage = YuvImage(nv21Bytes, ImageFormat.NV21, width, height, null)
            val outputStream = ByteArrayOutputStream()
            yuvImage.compressToJpeg(rect, quality = 90, outputStream)
            outputStream.toByteArray()
        }
    }
}
```

**Reasoning:**
- YUV is efficient for camera processing but can't be displayed directly
- JPEG is standard for image storage and display
- Compression quality set to 90% (good balance of size/quality)

**Trade-off:** Adds ~50-100ms conversion time per photo, but ensures compatibility.

---

#### 4. Minimize Latency Capture Mode

```kotlin
ImageCapture.Builder()
    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
    .build()
```

**Decision:** Prioritize speed over quality.

**Reasoning:**
- Photobooth takes 3 photos in quick succession
- Users expect fast capture after countdown
- Trade-off: Slightly lower quality acceptable for fun photobooth app

**Alternative:** `CAPTURE_MODE_MAXIMIZE_QUALITY` - slower but better quality. Could make this configurable.

---

#### 5. Camera Lifecycle Management

**Decision:** Bind camera to Activity/Fragment lifecycle via `LifecycleOwner`.

```kotlin
cameraProvider.bindToLifecycle(
    lifecycleOwner,    // Automatically handles pause/resume
    cameraSelector,
    preview,
    imageCapture
)
```

**Reasoning:**
- Camera automatically pauses when app backgrounds (saves battery)
- Camera automatically resumes when app returns
- Prevents camera lock issues

**Important:** Always call `release()` in ViewModel's `onCleared()` to free camera resources.

---

## Sony A7 III Camera Implementation

### Architecture

The Sony camera support is built as an alternative camera implementation that coexists with the native device camera.

#### Core Components

**`PhotoboothCamera` Interface** (`camera/domain/PhotoboothCamera.kt`)
- Unified interface for all camera types
- Provides: connection state, live view, capture functionality
- Platform-agnostic design

**`SonyA7IIICamera`** (`camera/data/sony/SonyA7IIICamera.kt`)
- Implements PhotoboothCamera interface
- Manages camera connection, live view, and capture
- Handles autofocus sequence (half-press → capture)

**`SonyCameraApiClient`** (`camera/data/sony/SonyCameraApiClient.kt`)
- JSON-RPC 2.0 over HTTP client
- Core methods: connect, capture, live view, settings
- Default camera IP: 192.168.122.1:10000

**`LiveViewStreamParser`** (`camera/data/sony/LiveViewStreamParser.kt`)
- Parses Sony's custom MJPEG-like stream format
- Extracts JPEG frames from binary stream
- Handles Sony's 8-byte + 128-byte header format

### Connection Setup

1. **Enable Remote Control on Camera**
   - Menu → Network → Ctrl w/ Smartphone → On
   - Menu → Network → Ctrl w/ Smartphone → Connection → Select connection method

2. **Connect Device to Camera WiFi**
   - **Android**: App can connect automatically (API 29+)
   - **iOS**: User must connect manually via Settings
   - Camera displays SSID and password (typically starts with "DIRECT-" or "ILCE-")

3. **Camera Configuration**
   - Default IP: `192.168.122.1`
   - API Port: `10000` (A7 III uses port 10000, not 8080)
   - Endpoint: `/sony/camera`

### Mark 1.0 - SD Card Workflow (Current Implementation)

**Status:** ✅ Production Ready
**Last Updated:** January 3, 2026

#### How It Works

The current implementation uses the Sony A7 III's continuous shooting mode. Photos are captured successfully but **saved directly to the camera's SD card** rather than transferred via WiFi. This is a limitation of the Sony A7 III Remote API, not the implementation.

**Capture Sequence:**
1. Stops live view (200ms delay)
2. Half-press shutter for autofocus (300ms for focus acquisition)
3. Starts continuous shooting mode (camera takes photos)
4. Polls camera events for image URLs (up to 2 seconds, 10 attempts)
5. Stops continuous shooting
6. **Result:** Photos saved to SD card only (no WiFi transfer)

**API Behavior Discovery:**
- The Sony A7 III Remote API does NOT expose `actTakePicture` method
- Available methods: `startContShooting`, `stopContShooting`, `actHalfPressShutter`
- Event data structure provides `takePictureUrl` array, but it remains empty even when photos are successfully captured

**User Experience:**
- ✅ Live view works perfectly (640×360 resolution)
- ✅ Autofocus works reliably
- ✅ Camera captures high-quality images to SD card
- ❌ No in-app photo preview after capture
- ❌ Manual SD card transfer required
- ❌ Cannot confirm specific photo was captured (only shutter sound)

The app displays **"Sony A7 III (Mark 1.0 - SD Card)"** in the camera selection screen to inform users that photos will be saved to SD card and require manual transfer.

### Live View

- Resolution: 640×360 (Sony A7 III limitation)
- Format: Custom MJPEG-like stream with Sony headers
- Frame structure:
  - 8-byte common header (start marker, payload type, sequence, timestamp)
  - 128-byte payload header (JPEG size at bytes 4-7)
  - JPEG data (variable size)

### API Methods Supported

**Connection & Setup:**
- `getAvailableApiList()` - List supported camera methods
- `startRecMode()` - Start recording mode
- `stopRecMode()` - Stop recording mode

**Capture:**
- `actHalfPressShutter()` - Autofocus
- `cancelHalfPressShutter()` - Release focus
- `startContShooting()` - Start continuous shooting (Mark 1.0)
- `stopContShooting()` - Stop continuous shooting

**Live View:**
- `startLiveview()` - Start live view stream
- `stopLiveview()` - Stop live view stream

**Camera Events:**
- `getEvent(longPolling)` - Poll camera state changes

### Platform Requirements

**Android:**
- Permissions: CAMERA, INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, CHANGE_WIFI_STATE, CHANGE_NETWORK_STATE
- Minimum SDK: 24 (Android 7.0)
- WiFi Connection: API 29+ for programmatic connection

**iOS:**
- Permissions: NSCameraUsageDescription, NSLocalNetworkUsageDescription
- Capabilities: Access WiFi Information (in Xcode)
- Note: Cannot connect to WiFi programmatically - users must connect manually

**Desktop (JVM):**
- Opens system network settings
- Checks camera reachability via ping

**Web (JS/WASM):**
- Limited functionality
- Manual WiFi connection required
- CORS issues may prevent camera access

### Dependencies

All dependencies managed via Gradle:

**Common:**
- `io.ktor:ktor-client-core`
- `io.ktor:ktor-client-content-negotiation`
- `io.ktor:ktor-serialization-kotlinx-json`
- `org.jetbrains.kotlinx:kotlinx-serialization-json`
- `androidx.datastore:datastore-preferences-core`

**Platform-Specific:**
- Android: `io.ktor:ktor-client-okhttp`
- iOS: `io.ktor:ktor-client-darwin`
- JVM: `io.ktor:ktor-client-java`
- JS/WASM: `io.ktor:ktor-client-js`

### Future Enhancements (Mark 2.0)

**Recommended Improvements:**

1. **Target Sony A7 IV or A7R IV**
   - These models reportedly support `actTakePicture` via Remote API
   - May provide direct WiFi image transfer
   - Verify API compatibility before implementation

2. **Alternative Approaches**
   - Investigate `awaitTakePicture` method (if available)
   - Try single-shot mode instead of continuous shooting
   - Check if different firmware versions expose different APIs
   - Consider using Sony's official SDK if available

3. **Hybrid Workflow**
   - Implement Mark 1.0 (SD card) as fallback
   - Detect if `actTakePicture` is available at runtime
   - Auto-select best workflow based on camera capabilities
   - Show workflow version clearly in UI

4. **SD Card Access**
   - Investigate if Remote API provides SD card browsing
   - Check `getContentsURI` or similar methods
   - May enable "capture to SD, then transfer via API" workflow

### Troubleshooting

**"Failed to connect to camera"**
- Ensure camera is in "Ctrl w/ Smartphone" mode
- Verify device is connected to camera's WiFi network
- Check camera IP (should be 192.168.122.1)

**"Capture failed"**
- Camera may be busy or in wrong mode
- Try restarting the camera
- Disconnect and reconnect

**"Live view not working"**
- Check network connection stability
- Try stopping and restarting live view
- Camera may need to be switched to correct shooting mode

**iOS "Cannot connect to WiFi"**
- This is expected - iOS cannot connect programmatically
- User must manually connect in Settings app
- App will detect connection once established

### References

- [Sony Camera Remote API (archived)](https://developer.sony.com/develop/cameras/)
- [Alpha Fairy - Sony Protocol Documentation](https://github.com/frank26080115/alpha-fairy)
- [ROCC Framework - Swift Implementation](https://github.com/simonmitchell/rocc)
- [pysony - Python Reference](https://github.com/storborg/sonypy)

---

## Platform-Specific Implementations

### WiFi Connection Management

**`WiFiConnectionManager`** (expect/actual pattern)
- **Android**: Programmatic WiFi connection (API 29+), network binding
- **iOS**: Opens Settings app (cannot connect programmatically)
- **JVM**: Opens system network settings
- **Web**: Shows manual connection instructions

### Device Camera Implementations

**Desktop (JVM)**
- Status: Placeholder only
- Future: Could use JavaFX or Swing for camera access

**Web (JS/WasmJS)**
- Status: Placeholder only
- Future: Could use WebRTC's `getUserMedia()` API for browser camera access

**iOS**
- Status: Placeholder only
- Future: Implement using AVFoundation (similar architecture to CameraX)

---

## Known Limitations

### Native Device Camera
- **No Photo Storage**: Photos exist only in memory, lost on navigation away from PhotoStripScreen (intentional for initial MVP)
- **Fixed Configuration**: Hardcoded 3 photos, 3 second countdown (good defaults for initial version)
- **No Flash/HDR Control**: Uses default camera settings (could expose CameraX controls in future)

### Sony A7 III Camera (Mark 1.0)
- ❌ No WiFi image transfer (SD card workflow only)
- ❌ No `actTakePicture` API method available on A7 III
- ❌ Cannot preview captured photos in app
- ❌ No touch-to-focus / AF point selection
- ❌ No RAW file transfer over WiFi
- ❌ Live view capped at 640×360
- ❌ No focus distance control
- ✅ Remote shutter via continuous shooting works
- ✅ Remote autofocus works
- ✅ Live view streaming works
- ✅ Photos successfully saved to SD card
- ✅ Exposure controls work (shutter, aperture, ISO)

### Platform Limitations
- **iOS**: No programmatic WiFi connection
- **Web**: Limited camera access, CORS restrictions
- **Device Camera**: Not yet implemented on non-Android platforms (stub only)

---

## Testing Approach

**Unit Tests:**
- Use mock `CameraController` for ViewModel tests
- Mock `SonyCameraApiClient` for Sony camera tests

**Integration Tests:**
- Native camera: Require real device/emulator with camera
- Sony camera: Require physical Sony A7 III and WiFi connection

**Challenge:**
- CameraX tests need instrumented tests (can't run in pure JVM tests)
- Sony camera tests require physical hardware

---

## Performance Considerations

### Native Device Camera

**Capture Sequence Timeline:**
```
Countdown (3s) → Capture (~100ms) → Delay (500ms) → Repeat
```

**Total time for 3 photos:** ~11 seconds
- 3 countdowns × 3 seconds = 9 seconds
- 3 captures × ~100ms = 300ms
- 2 delays × 500ms = 1 second

**Optimization Opportunities:**
- Reduce inter-photo delay from 500ms to 300ms
- Pre-warm camera during countdown
- Parallel JPEG conversion (currently sequential)

### Sony A7 III Camera

**Live View Performance:**
- 640×360 resolution at ~15-30 fps
- Low latency for composition feedback

**Capture Sequence:**
- Live view stop: 200ms
- Autofocus: 300ms
- Continuous shooting: Variable (depends on camera settings)
- Event polling: Up to 2 seconds

---

## Camera Selection Flow

```
Welcome Screen
    ↓
Camera Selection Screen
    ├─→ Native Device Camera → PhotoboothScreen (4 photos) → Photo Strip
    └─→ Sony A7 III → CameraPreviewScreen (single photo, SD card workflow)
```

User selection is persisted via DataStore and restored on app restart.
