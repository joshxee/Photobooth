# Camera System

## Overview

The photobooth app supports **multiple camera modes** with a unified camera selection interface:

1. **Native Device Camera** - Built-in camera using CameraX (Android), AVFoundation (iOS), etc.
   - Full photobooth experience with countdown timer
   - 4-photo strip generation
   - Platform-specific implementations using expect/actual pattern

2. **Sony A7 III (Mark 1.1 - Screenshot)** - Screenshot-based workflow
   - Live view screenshots for instant photo strips
   - Works with any camera drive mode
   - High-resolution backups saved to SD card

3. **Sony A7 III (Mark 2.0 - WiFi Transfer)** - True WiFi photo transfer
   - Downloads actual full-resolution photos
   - Requires Single Shooting mode + JPEG/RAW+JPEG format
   - Professional quality images in app

Users can choose their preferred camera mode at runtime via the Camera Selection screen, and the selection persists across app launches using DataStore.

## Logging System

The Sony Camera API includes comprehensive logging for debugging and development.

### Log Tag

All Sony camera logs use the tag: **`SonyCameraApi`**

### Filtering Logs

**Android Logcat (terminal):**
```bash
adb logcat -s SonyCameraApi
adb logcat SonyCameraApi:D *:S
```

**Android Studio Logcat panel:**
- Filter by tag: `SonyCameraApi`

### Log Prefixes

| Prefix | Source |
|--------|--------|
| `API_CALL` | Low-level API requests/responses |
| `[MARK2_VM]` | Mark 2.0 ViewModel operations |
| `CAPTURE WORKFLOW` | Capture sequence steps |

### Log Levels

- **D (Debug):** API call details, countdown ticks
- **I (Info):** Workflow steps, success messages, URLs
- **W (Warning):** Non-critical failures, recoverable errors
- **E (Error):** Critical failures, exceptions

### Platform-Specific Loggers

The logging system uses expect/actual pattern:
- **Android:** Uses `android.util.Log` for proper logcat integration
- **JVM/iOS/JS/Wasm:** Uses `println` as fallback

### Enabling Logging

Logging is enabled by default when using `createPlatformLogger()`:
```kotlin
val apiClient = SonyCameraApiClient(logger = createPlatformLogger())
```

To disable logging:
```kotlin
val apiClient = SonyCameraApiClient(logger = NoOpLogger)
```

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

### Required Camera Settings for actTakePicture

**CRITICAL:** The Sony A7 III requires specific settings for `actTakePicture` to be available via the Remote API.

#### Required Settings

1. **Drive Mode: Single Shooting**
   - Menu → Camera Settings 1 → Drive Mode → Single Shooting
   - ❌ Continuous shooting modes disable `actTakePicture`
   - ❌ Bracketing modes disable `actTakePicture`

2. **File Format: JPEG or RAW+JPEG**
   - Menu → Camera Settings 1 → Quality → RAW+JPEG or JPEG
   - Tested working: RAW+JPEG (Fine)
   - ❌ RAW-only may have different behavior

#### API Availability by Mode

| Camera Mode | actTakePicture | startContShooting | Notes |
|-------------|----------------|-------------------|-------|
| Single Shooting + JPEG | ✅ Available | ❌ | Recommended for API capture |
| Single Shooting + RAW+JPEG | ✅ Available | ❌ | Tested working |
| Continuous Hi/Lo | ❌ Error 40400 | ✅ Available | Use cont shooting API |
| Bracketing modes | ❌ | ❌ | Not supported |

#### Error Codes Reference

- **40400**: "Shooting method not available" - Camera is in wrong drive mode
- **40403**: "Camera not ready" - Still processing or focusing
- **5**: "Illegal argument" - Invalid parameters
- **12**: "Method not found" - API doesn't exist on this camera

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

## Mark 1.1 - Screenshot Workflow

**Status:** ✅ Production Ready
**Last Updated:** January 2026
**Location:** `ui/photobooth/sony/SonyPhotoboothScreen.kt`

### Overview

Mark 1.1 enhances the Sony photobooth experience by capturing **live view screenshots** instead of relying on WiFi image transfer (which the A7 III doesn't support). This enables a true photobooth workflow with multi-photo sequences and countdown timers while maintaining the SD card workflow for high-resolution archival.

### User Flow

1. **Enter Photobooth Mode:** User selects Sony A7 III → navigates to Sony photobooth screen
2. **Live View Active:** Live view displays continuously from camera
3. **Start Sequence:** User clicks "Start Photo Booth" button
4. **For Each Photo** (configurable 1-10, default 4):
   - **Countdown:** 3...2...1 (configurable, default 3 seconds) - live view continues
   - **Freeze:** At countdown 0, live view freezes on last frame
   - **Screenshot:** Frozen frame captured and encoded to JPEG (quality 90)
   - **Camera Trigger:** Camera shutter fires via continuous shooting mode (photo saved to SD card)
   - **Unfreeze:** Live view resumes for next photo (if not last)
5. **Photo Strip:** Navigate to photo strip showing all screenshots
6. **Session Continues:** Camera connection stays alive for next photobooth session

### Technical Implementation

**Architecture:**
- **SonyPhotoboothViewModel:** State management and capture sequence orchestration
- **SonyPhotoboothScreen:** UI composable with live view display and countdown overlay
- **ImageBitmapEncoder:** Platform-specific JPEG encoding (expect/actual pattern)
- **State Classes:** `SonyCaptureState`, `LiveViewState`, `SonyPhotoboothUiState`

**Capture Sequence Logic:**
```kotlin
repeat(numberOfPhotos) { index ->
    // Countdown (live view active)
    for (countdown in countdownSeconds downTo 1) {
        updateState(Countdown(countdown, index + 1, totalPhotos))
        delay(1000L) // Only delay for countdown timer
    }

    // Freeze frame at 0
    val currentFrame = camera.liveViewFrame.value
    updateState(Frozen(currentFrame))

    // Screenshot frozen frame (synchronous, ~50ms)
    val photoBytes = encodeImageBitmapToJpeg(currentFrame, quality = 90)
    photos.add(PhotoData(photoBytes, timestamp))

    // Camera capture (continuous shooting → SD card)
    camera.capture() // Fire and forget

    // Unfreeze for next photo (immediate, no delay)
    if (index < numberOfPhotos - 1) {
        updateState(Active(camera.liveViewFrame.value))
    }
}
```

**Live View Freeze Coordination:**
- **Active State:** Continuously collect from `camera.liveViewFrame` StateFlow
- **Freeze State:** Stop collecting, display cached `ImageBitmap`
- **Screenshot:** Encode frozen frame to JPEG ByteArray using platform-specific encoders
- **Unfreeze:** Resume collecting from StateFlow for next photo

**Platform-Specific Encoding:**
- **Android:** `Bitmap.compress(JPEG, quality, outputStream)` via `asAndroidBitmap()`
- **JVM:** `ImageIO.write(bufferedImage, "JPEG", outputStream)` via `toAwtImage()`
- **iOS/JS/Wasm:** Stub implementations (future enhancement)

### Resolution & Quality

| Aspect | Screenshot (Photo Strip) | SD Card Photo (Archive) |
|--------|-------------------------|-------------------------|
| **Resolution** | 640×360 (live view limitation) | 6000×4000 (full camera resolution) |
| **Format** | JPEG (quality 90) | RAW + JPEG (camera setting) |
| **File Size** | ~50-100 KB per photo | ~5-10 MB per photo (JPEG) |
| **Purpose** | Instant photo strip preview | High-resolution archival |

### Performance Characteristics

**Timing Breakdown (4 photos, 3-second countdown):**
- 4 × countdown (3 seconds each) = **12 seconds**
- 4 × screenshot encoding (~50ms each) = **200ms**
- Camera capture triggers = **~1 second** (concurrent with UI)
- **Total sequence time: ~13 seconds**

**Optimization:**
- **Minimal delays:** Only countdown timer delays (1000ms/sec)
- **No artificial waits:** Screenshot, capture, and unfreeze happen immediately
- **Synchronous encoding:** JPEG encoding completes in ~50ms (acceptable blocking)
- **Concurrent capture:** Camera trigger runs in background while UI transitions

### Settings Integration

Uses existing `SettingsRepository` (shared with native camera photobooth):
- **Number of Photos:** 1-10 (default: 4)
- **Countdown Seconds:** 1-10 (default: 3)

Changes via Settings screen apply to both native and Sony photobooth workflows.

### User Experience

**Advantages:**
- ✅ Multi-photo sequences with countdown timer
- ✅ In-app photo strip preview (instant gratification)
- ✅ Smooth live view throughout session
- ✅ Configurable photo count and countdown
- ✅ Full-resolution backups on SD card
- ✅ No WiFi transfer delays or failures

**Limitations:**
- ⚠️ Photo strip shows 640×360 screenshots, not full-resolution photos
- ⚠️ Screenshot timing may differ slightly from actual shutter timing (~50-100ms)
- ⚠️ SD card photos still require manual transfer for high-resolution access

**User Communication:**
The app displays **"Sony A7 III (Mark 1.1 - Photobooth)"** to indicate the enhanced photobooth workflow with in-app photo strips.

### Comparison: Mark 1.0 vs. Mark 1.1

| Feature | Mark 1.0 (SD Card Only) | Mark 1.1 (Screenshot Workflow) |
|---------|------------------------|-------------------------------|
| **Workflow** | Single photo capture | Multi-photo photobooth sequence |
| **Preview** | No in-app preview | Screenshot-based photo strip |
| **Countdown** | None | Configurable (1-10 seconds) |
| **Photo Count** | 1 | Configurable (1-10 photos) |
| **Resolution** | SD card only (full res) | Screenshots 640×360 + SD card backups |
| **User Experience** | Manual SD card transfer | Instant photo strip + backups |
| **Capture Method** | Continuous shooting | Continuous shooting + screenshot |
| **Connection Management** | Manual connect/disconnect | Persistent connection |

### Future Enhancements (Mark 2.0)

**Potential improvements for newer Sony camera models with full WiFi transfer support:**
- High-resolution photo download via WiFi (if camera supports `actTakePicture` with URLs)
- Background photo transfer while user views photo strip
- Auto-upload to cloud storage
- Print queue integration

**Current Mark 1.1 design decisions:**
- Screenshot approach chosen due to A7 III API limitations (no WiFi transfer)
- Intentionally simple: no complex download/retry logic
- Optimized for speed: minimal delays, instant photo strip

### Continuous Shooting Mode

**IMPORTANT:** Sony A7 III **ONLY** supports continuous shooting mode for capture:
- `startContShooting()` + `stopContShooting()` - ✅ Available
- `actTakePicture()` - ❌ **NOT available** on A7 III

Mark 1.1 uses the existing `camera.capture()` method which internally calls continuous shooting. Photos are saved to SD card, but image URLs remain empty (Mark 1.0 behavior). The screenshot provides the in-app photo strip representation.

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

## Mark 2.0 - WiFi Transfer Workflow

**Status:** ✅ Production Ready
**Last Updated:** January 2026
**Location:** `ui/photobooth/sony/mark2/`

### Overview

Mark 2.0 implements **true WiFi photo transfer** using the `actTakePicture` API. Unlike Mark 1.1 (which uses screenshots of live view), Mark 2.0 downloads the **actual captured photos** from the camera.

### Required Camera Settings

**CRITICAL:** Mark 2.0 only works with specific camera settings:

1. **Drive Mode: Single Shooting**
   - Menu → Camera Settings 1 → Drive Mode → Single Shooting

2. **File Format: JPEG or RAW+JPEG**
   - Menu → Camera Settings 1 → Quality → JPEG or RAW+JPEG

Without these settings, the `actTakePicture` API returns error 40400.

### Capture Workflow

```
For each photo:
1. Countdown (3...2...1) - Live view continues
2. Start live view (if needed)
3. Half-press shutter (autofocus)
4. Wait for focus lock (300ms)
5. actTakePicture → Returns image URL
6. Download photo from URL
7. Show preview (1.5 seconds)
8. Continue to next photo
```

### Technical Implementation

**Files:**
- `SonyMark2ViewModel.kt` - ViewModel with capture workflow
- `SonyMark2Screen.kt` - UI composable
- `SonyCameraApiClient.kt` - `executeCaptureWorkflow()` method

**Key Differences from Mark 1.1:**
- Uses `actTakePicture` instead of `startContShooting`
- Downloads actual photos via returned URLs
- Displays real captured images (not live view screenshots)
- Requires specific camera settings

### Photo Quality

| Aspect | Mark 1.1 (Screenshot) | Mark 2.0 (WiFi Transfer) |
|--------|----------------------|-------------------------|
| **Resolution** | 640×360 (live view) | Full camera resolution |
| **Source** | Live view frame | Actual captured image |
| **Format** | JPEG (encoded screenshot) | JPEG from camera |
| **File Size** | ~50-100 KB | ~2-10 MB |

### Logging

Filter in logcat: `adb logcat -s SonyCameraApi`

Mark 2.0 logs are prefixed with `[MARK2_VM]`:
```
[MARK2_VM] Starting Mark 2.0 capture sequence
[MARK2_VM] ─── Photo 1/4 ───
[MARK2_VM] Countdown: 3
[MARK2_VM] Capturing photo 1...
[MARK2_VM] Downloading from: http://...
[MARK2_VM] Downloaded 4523891 bytes
```

### Error Handling

| Error Code | Meaning | Solution |
|------------|---------|----------|
| 40400 | Wrong drive mode | Set camera to Single Shooting |
| 40403 | Camera not ready | Wait and retry |
| Timeout | Connection issue | Check WiFi connection |

### User Experience

**Advantages over Mark 1.1:**
- ✅ Full-resolution photos in app
- ✅ Actual captured images (not screenshots)
- ✅ Professional quality photo strip
- ✅ No manual SD card transfer needed

**Limitations:**
- ⚠️ Requires specific camera settings
- ⚠️ Slower capture (~2-3 seconds per photo for download)
- ⚠️ RAW files not transferred (only JPEG)

### Future Enhancements

- Background photo transfer while countdown continues
- RAW file transfer support
- Touch-to-focus on live view
- Auto-detection of camera settings compatibility
- Hybrid mode: Auto-select Mark 1.1 or 2.0 based on camera settings

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

### Sony A7 III Camera (Mark 1.1 - Screenshot)
- ❌ Photos are 640×360 screenshots (not actual captured images)
- ❌ No touch-to-focus / AF point selection
- ❌ Live view capped at 640×360
- ✅ Works with any camera drive mode
- ✅ Remote shutter via continuous shooting works
- ✅ Remote autofocus works
- ✅ High-res backups saved to SD card

### Sony A7 III Camera (Mark 2.0 - WiFi Transfer)
- ❌ Requires Single Shooting mode (error 40400 otherwise)
- ❌ Requires JPEG or RAW+JPEG format
- ❌ Slower capture (~2-3s per photo for download)
- ❌ RAW files not transferred (only JPEG)
- ❌ No touch-to-focus / AF point selection
- ✅ Downloads actual full-resolution photos
- ✅ True WiFi image transfer
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
