# Camera System

## Overview

The camera system is implemented using the expect/actual pattern, with Android using CameraX and other platforms having placeholder implementations.

## Android Implementation (CameraX)

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

## Platform-Specific Implementations

### Desktop (JVM)
**Status:** Placeholder only

**Future:** Could use JavaFX or Swing for camera access, but requires platform-specific libraries.

### Web (JS/WasmJS)
**Status:** Placeholder only

**Future:** Could use WebRTC's `getUserMedia()` API for browser camera access.

### iOS
**Status:** Placeholder only

**Future:** Implement using AVFoundation (similar architecture to CameraX).

---

## Known Limitations

### 1. No Photo Storage
**Current:** Photos exist only in memory, lost on navigation away from PhotoStripScreen.

**Reasoning:** Initial requirement was for a simple photobooth experience.

**Future:** Add save-to-gallery option with platform-specific storage APIs.

### 2. Fixed Configuration
**Current:** Hardcoded 3 photos, 3 second countdown.

**Reasoning:** Good defaults for initial version.

**Future:** Add settings screen to customize.

### 3. No Flash/HDR Control
**Current:** Uses default camera settings.

**Future:** Could expose CameraX's flash and HDR controls.

---

## Testing Approach

**Unit Tests:** Use mock `CameraController` for ViewModel tests.

**Integration Tests:** Require real device/emulator with camera.

**Challenge:** CameraX tests need instrumented tests (can't run in pure JVM tests).

---

## Performance Considerations

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
