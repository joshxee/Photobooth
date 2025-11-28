# Platform Support

## Current Platform Status

| Platform | Status | Camera | Permissions | UI |
|----------|--------|--------|-------------|-----|
| Android  | ✅ Full | CameraX | Full | Full |
| iOS      | 🚧 Placeholder | Mock | Mock | Full |
| Desktop (JVM) | 🚧 Placeholder | Mock | Mock | Full |
| Web (JS) | 🚧 Placeholder | Mock | Mock | Full |
| Web (Wasm) | 🚧 Placeholder | Mock | Mock | Full |

---

## Android Implementation

### CameraX Integration

**Dependencies:**
```kotlin
androidMain.dependencies {
    implementation("androidx.camera:camera-camera2:1.3.1")
    implementation("androidx.camera:camera-lifecycle:1.3.1")
    implementation("androidx.camera:camera-view:1.3.1")
}
```

**Why CameraX?**
- Official Jetpack library
- Handles device fragmentation (works across 1000s of Android devices)
- Lifecycle-aware
- Modern API with use cases (Preview, ImageCapture, ImageAnalysis)

**Alternative Considered:** Camera2 API - Rejected because:
- Lower-level, more complex
- Manual device compatibility handling
- CameraX provides better developer experience

### Permission Handling

**Implementation:** `AndroidCameraPermissionHandler`

```kotlin
class AndroidCameraPermissionHandler(private val context: Context) {
    override fun checkPermission(): PermissionState {
        return when (ContextCompat.checkSelfPermission(context, CAMERA)) {
            PackageManager.PERMISSION_GRANTED -> PermissionState.GRANTED
            else -> PermissionState.DENIED
        }
    }
}
```

**Android Manifest:**
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

**Design Decision:** `android:required="false"` allows app installation on devices without cameras.

### Compose Interop

**Pattern:** `AndroidView` for CameraX preview.

```kotlin
@Composable
actual fun CameraPreview(controller: CameraController, modifier: Modifier) {
    val previewView = remember { PreviewView(context) }

    AndroidView(
        factory = { previewView },
        modifier = modifier
    )
}
```

**Why AndroidView?** CameraX preview requires a `PreviewView`, which is a standard Android View. `AndroidView` bridges traditional Views with Compose.

---

## iOS Implementation (Future)

### Proposed Approach

**Camera:** AVFoundation framework

```swift
// Future iOS implementation
class IOSCameraController: CameraController {
    let captureSession = AVCaptureSession()

    func capturePhoto() async -> PhotoData {
        // Use AVCapturePhotoOutput
    }
}
```

**Permission:** Info.plist + AVCaptureDevice authorization

```xml
<key>NSCameraUsageDescription</key>
<string>We need camera access to take photobooth photos.</string>
```

**Compose UI:** Already works - `PhotoboothScreen` is in `commonMain`.

**Effort Estimate:** ~3-5 days for full iOS camera implementation.

---

## Desktop (JVM) Implementation

### Current Status

**Placeholder:** Returns mock data.

```kotlin
class JvmCameraController : CameraController {
    override suspend fun capturePhoto() =
        PhotoData(byteArrayOf(1, 2, 3), System.currentTimeMillis())
}
```

### Future Options

#### Option 1: JavaFX Camera
```kotlin
// Pseudo-code
val camera = WebCamService()
val image = camera.capture()
```

**Pros:** Native Java integration
**Cons:** Heavy dependency, not all platforms have camera

#### Option 2: OpenCV
```kotlin
val camera = VideoCapture(0)
val frame = Mat()
camera.read(frame)
```

**Pros:** Powerful image processing
**Cons:** Large native library, complex setup

**Decision:** Defer until desktop camera support is actually needed.

---

## Web Implementation

### Current Status

**Placeholder:** Returns mock data.

### Future: WebRTC API

```kotlin
// JS implementation using kotlinx-browser
external interface MediaDevices {
    fun getUserMedia(constraints: dynamic): Promise<MediaStream>
}

suspend fun capturePhotoFromWebcam(): PhotoData = suspendCoroutine { cont ->
    navigator.mediaDevices.getUserMedia(object {
        val video = true
    }).then { stream ->
        // Capture frame from video stream
        val imageData = captureFrameFromStream(stream)
        cont.resume(PhotoData(imageData, Date.now().toLong()))
    }
}
```

**Challenges:**
- Browser permissions (user must allow camera access)
- Different behavior across browsers
- HTTPS required for camera access

**Wasm vs JS:** Same approach for both, just different compilation targets.

**Effort Estimate:** ~2-3 days for web camera implementation.

---

## Cross-Platform Code Sharing

### What's Shared (commonMain)

✅ **Models:** PhotoData, PhotoboothConfig, Screen
✅ **State:** CaptureState, PhotoboothUiState
✅ **ViewModel:** PhotoboothViewModel (100% of business logic)
✅ **UI:** PhotoboothScreen, PhotoStripScreen (95% of UI)
✅ **Interfaces:** CameraController, PermissionHandler

**Shared Code:** ~85% of codebase

### What's Platform-Specific

❌ **Camera Implementation:** CameraX (Android), AVFoundation (iOS), etc.
❌ **Permissions:** Each platform has different permission APIs
❌ **Camera Preview:** AndroidView (Android), UIViewRepresentable (iOS), etc.

**Platform Code:** ~15% of codebase

---

## Platform-Specific Testing

### Test Isolation

**Common Tests:** Run on ALL platforms
```kotlin
// composeApp/src/commonTest/
@Test
fun `ViewModel countdown logic works`() {
    // Runs on JVM, Android, JS, Wasm, iOS
}
```

**Platform Tests:** Run on specific platform
```kotlin
// composeApp/src/androidTest/
@Test
fun `CameraX captures photo correctly`() {
    // Only runs on Android
}
```

### Test Double Strategy

**Common test doubles** work across all platforms:
```kotlin
class TestCameraController : CameraController {
    // Works everywhere - no platform dependencies
}
```

---

## Platform-Specific Build Configuration

### Android
```kotlin
android {
    compileSdk = 34
    minSdk = 24  // Android 7.0+ (CameraX requirement)

    defaultConfig {
        applicationId = "com.jc.photobooth"
    }
}
```

**Minimum SDK Decision:** SDK 24 required for CameraX. Covers ~94% of Android devices (as of 2024).

### iOS (Future)
```kotlin
iosArm64 {
    binaries.framework {
        baseName = "ComposeApp"
        // Will link against AVFoundation
    }
}
```

### Desktop
```kotlin
compose.desktop {
    application {
        mainClass = "com.jc.photobooth.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
        }
    }
}
```

---

## Platform Feature Matrix

### Current Features

| Feature | Android | iOS | Desktop | Web |
|---------|---------|-----|---------|-----|
| Welcome Screen | ✅ | ✅ | ✅ | ✅ |
| Navigation | ✅ | ✅ | ✅ | ✅ |
| Camera Permission | ✅ | 🚧 | 🚧 | 🚧 |
| Camera Preview | ✅ | 🚧 | 🚧 | 🚧 |
| Photo Capture | ✅ | 🚧 | 🚧 | 🚧 |
| Countdown Timer | ✅ | ✅ | ✅ | ✅ |
| Photo Strip Display | ✅ | ⚠️* | ⚠️* | ⚠️* |

*Depends on image rendering from mock bytes

### Future Expansion Priority

1. **iOS** - Second most important platform for mobile photobooth
2. **Web** - Enables browser-based photobooth kiosks
3. **Desktop** - Lower priority (less common use case)

---

## Known Platform Limitations

### Android
- ⚠️ Minimum SDK 24 (excludes very old devices)
- ⚠️ Requires camera hardware feature

### iOS (Future)
- ⚠️ Will require iOS 14+ for SwiftUI integration
- ⚠️ Camera permission must be in Info.plist

### Web (Future)
- ⚠️ HTTPS required for camera access
- ⚠️ User must grant camera permission in browser
- ⚠️ Limited control over camera settings

### Desktop (Future)
- ⚠️ Camera availability varies by device
- ⚠️ May need different implementations per OS (Windows/Mac/Linux)
