# Sony A7 III Camera Support

This document describes the Sony A7 III camera integration for the Photobooth app.

## Overview

The app now supports **dual camera modes** with a unified camera selection interface:
1. **Native Device Camera** - Built-in camera using CameraX (Android), AVFoundation (iOS), etc.
   - Full photobooth experience with countdown timer
   - 4-photo strip generation
   - Complete implementation from main branch
2. **Sony A7 III** - External mirrorless camera via WiFi using Sony's Camera Remote API
   - Professional camera quality
   - Live view preview
   - Single photo capture
   - WiFi-based remote control

## Integration Approach

This implementation **extends** the existing native camera functionality rather than replacing it:

- **Preserved**: All native camera code from main branch (PhotoboothScreen, CameraController, PhotoStripScreen)
- **Added**: Sony camera support as an alternative option
- **Integrated**: Unified camera selection screen that routes to the appropriate implementation
- **Coexistence**: Both camera implementations work side-by-side

Users can choose their preferred camera mode at runtime, and the selection persists across app launches.

## Architecture

### Core Components

#### 1. Camera Abstraction Layer
- **`PhotoboothCamera`** interface (`camera/domain/PhotoboothCamera.kt`)
  - Unified interface for all camera types
  - Provides: connection state, live view, capture functionality
  - Platform-agnostic design

#### 2. Sony Camera Implementation
- **`SonyA7IIICamera`** (`camera/data/sony/SonyA7IIICamera.kt`)
  - Implements PhotoboothCamera interface
  - Manages camera connection, live view, and capture
  - Handles autofocus sequence (half-press → capture)

- **`SonyCameraApiClient`** (`camera/data/sony/SonyCameraApiClient.kt`)
  - JSON-RPC 2.0 over HTTP client
  - Core methods: connect, capture, live view, settings
  - Default camera IP: 192.168.122.1:8080

- **`LiveViewStreamParser`** (`camera/data/sony/LiveViewStreamParser.kt`)
  - Parses Sony's custom MJPEG-like stream format
  - Extracts JPEG frames from binary stream
  - Handles Sony's 8-byte + 128-byte header format

#### 3. Platform-Specific Components
- **`WiFiConnectionManager`** (expect/actual pattern)
  - **Android**: Programmatic WiFi connection (API 29+), network binding
  - **iOS**: Opens Settings app (cannot connect programmatically)
  - **JVM**: Opens system network settings
  - **Web**: Shows manual connection instructions

- **`DeviceCamera`** (expect/actual pattern)
  - Stub implementations across all platforms
  - Ready for CameraX (Android), AVFoundation (iOS), etc.

#### 4. Repository Layer
- **`CameraRepository`** (`camera/domain/CameraRepository.kt`)
  - Manages camera instances
  - Persists user preferences (DataStore)
  - Handles camera switching

### UI Components & User Flow

#### App Flow
```
Welcome Screen
    ↓
Camera Selection
    ├─→ Native Camera → PhotoboothScreen (4 photos) → Photo Strip
    └─→ Sony A7 III → CameraPreviewScreen (single photo)
```

#### 1. Camera Selection Screen
- **`CameraSelectionScreen`** (`camera/ui/CameraSelectionScreen.kt`)
  - Choose between Native Device Camera and Sony A7 III
  - Displays both available cameras
  - Persists selection via DataStore
  - Routes to appropriate camera implementation

#### 2. Native Camera Flow (from main branch)
- **`PhotoboothScreenWrapper`** - Platform-specific camera wrapper
- **`PhotoboothScreen`** - Full photobooth experience
  - 4-photo countdown capture sequence
  - Permission handling
  - Photo strip generation
- **`PhotoStripScreen`** - Display and share photo strip

#### 3. Sony Camera Flow (this PR)
- **`CameraPreviewScreen`** (`camera/ui/CameraPreviewScreen.kt`)
  - Live view display from Sony camera
  - Connection status indicator
  - WiFi connection guidance
  - Single photo capture button with progress feedback
  - Photo preview with retake/save options

## Sony A7 III Connection Guide

### Camera Setup

1. **Enable Remote Control on Camera**
   - Menu → Network → Ctrl w/ Smartphone → **On**
   - Menu → Network → Ctrl w/ Smartphone → Connection → Select connection method

2. **Connect Device to Camera WiFi**
   - **Android**: App can connect automatically (API 29+)
   - **iOS**: User must connect manually via Settings
   - Camera displays SSID and password (typically starts with "DIRECT-" or "ILCE-")

3. **Camera Configuration**
   - Default IP: `192.168.122.1`
   - API Port: `8080`
   - Endpoint: `/sony/camera`

### Capture Sequence

The app follows Sony's recommended capture flow:

1. **Half-Press Shutter** (`actHalfPressShutter`)
   - Triggers autofocus
   - Wait ~300ms for focus acquisition

2. **Take Picture** (`actTakePicture`)
   - Captures image
   - Returns JPEG URL(s)

3. **Cancel Half-Press** (`cancelHalfPressShutter`)
   - Releases shutter button

4. **Download Image**
   - Downloads JPEG from camera's HTTP server
   - Converts to ImageBitmap for display

### Live View

- Resolution: 640×360 (Sony A7 III limitation)
- Format: Custom MJPEG-like stream with Sony headers
- Frame structure:
  - 8-byte common header (start marker, payload type, sequence, timestamp)
  - 128-byte payload header (JPEG size at bytes 4-7)
  - JPEG data (variable size)

## API Methods Supported

### Connection & Setup
- `getAvailableApiList()` - List supported camera methods
- `startRecMode()` - Start recording mode
- `stopRecMode()` - Stop recording mode

### Capture
- `actHalfPressShutter()` - Autofocus
- `cancelHalfPressShutter()` - Release focus
- `actTakePicture()` - Capture image

### Live View
- `startLiveview()` - Start live view stream
- `stopLiveview()` - Stop live view stream

### Camera Events
- `getEvent(longPolling)` - Poll camera state changes

## Platform Requirements

### Android
**Permissions** (added to AndroidManifest.xml):
- `CAMERA` - Device camera access
- `INTERNET` - HTTP communication
- `ACCESS_NETWORK_STATE` - Network status
- `ACCESS_WIFI_STATE` - WiFi SSID detection
- `CHANGE_WIFI_STATE` - WiFi connection
- `CHANGE_NETWORK_STATE` - Network binding

**Minimum SDK**: 24 (Android 7.0)
**WiFi Connection**: API 29+ for programmatic connection

### iOS
**Permissions** (added to Info.plist):
- `NSCameraUsageDescription` - Device camera access
- `NSLocalNetworkUsageDescription` - Local network access
- `com.apple.developer.networking.wifi-info` - WiFi SSID access

**Capabilities Required**:
- Access WiFi Information (in Xcode)

**Note**: iOS cannot connect to WiFi programmatically. Users must connect manually.

### Desktop (JVM)
- Opens system network settings
- Checks camera reachability via ping

### Web (JS/WASM)
- Limited functionality
- Manual WiFi connection required
- CORS issues may prevent camera access

## Dependencies Added

### Common
```kotlin
implementation("io.ktor:ktor-client-core")
implementation("io.ktor:ktor-client-content-negotiation")
implementation("io.ktor:ktor-serialization-kotlinx-json")
implementation("org.jetbrains.kotlinx:kotlinx-serialization-json")
implementation("androidx.datastore:datastore-preferences-core")
```

### Platform-Specific
```kotlin
// Android
implementation("io.ktor:ktor-client-okhttp")

// iOS
implementation("io.ktor:ktor-client-darwin")

// JVM
implementation("io.ktor:ktor-client-java")

// JS/WASM
implementation("io.ktor:ktor-client-js")
```

## Known Limitations

### Sony A7 III Limitations
- ❌ No touch-to-focus / AF point selection
- ❌ No RAW file transfer over WiFi
- ❌ Live view capped at 640×360
- ❌ No focus distance control
- ✅ Remote shutter, autofocus, exposure control work
- ✅ JPEG transfer works

### Platform Limitations
- **iOS**: No programmatic WiFi connection
- **Web**: Limited camera access, CORS restrictions
- **Device Camera**: Not yet implemented (stub only)

## Testing

Since this is WiFi-based, testing requires:
1. Physical Sony A7 III camera
2. Camera in "Ctrl w/ Smartphone" mode
3. Device connected to camera's WiFi network

**Mock Testing**: The `SonyCameraApiClient` can be mocked for unit tests.

## Future Enhancements

### Short Term
1. Implement DeviceCamera for Android (CameraX)
2. Implement DeviceCamera for iOS (AVFoundation)
3. Add exposure controls UI (aperture, shutter, ISO)
4. Add photo gallery/storage

### Long Term
1. Support other Sony cameras (A7 IV, A7R series)
2. Burst mode / photo sequences
3. Video recording support
4. Image filters and effects

## Troubleshooting

### "Failed to connect to camera"
- Ensure camera is in "Ctrl w/ Smartphone" mode
- Verify device is connected to camera's WiFi network
- Check camera IP (should be 192.168.122.1)

### "Capture failed"
- Camera may be busy or in wrong mode
- Try restarting the camera
- Disconnect and reconnect

### "Live view not working"
- Check network connection stability
- Try stopping and restarting live view
- Camera may need to be switched to correct shooting mode

### iOS "Cannot connect to WiFi"
- This is expected - iOS cannot connect programmatically
- User must manually connect in Settings app
- App will detect connection once established

## References

- [Sony Camera Remote API (archived)](https://developer.sony.com/develop/cameras/)
- [Alpha Fairy - Sony Protocol Documentation](https://github.com/frank26080115/alpha-fairy)
- [ROCC Framework - Swift Implementation](https://github.com/simonmitchell/rocc)
- [pysony - Python Reference](https://github.com/storborg/sonypy)

## Project Structure

```
composeApp/src/
├── commonMain/kotlin/com/jc/photobooth/
│   ├── camera/
│   │   ├── domain/           # Interfaces & domain models
│   │   │   ├── PhotoboothCamera.kt
│   │   │   ├── CameraType.kt
│   │   │   ├── CameraRepository.kt
│   │   │   └── WiFiConnectionManager.kt (expect)
│   │   ├── data/
│   │   │   ├── sony/         # Sony camera implementation
│   │   │   │   ├── SonyA7IIICamera.kt
│   │   │   │   ├── SonyCameraApiClient.kt
│   │   │   │   └── LiveViewStreamParser.kt
│   │   │   └── device/       # Device camera (expect)
│   │   │       └── DeviceCamera.kt
│   │   └── ui/               # Camera UI screens
│   │       ├── CameraSelectionScreen.kt
│   │       └── CameraPreviewScreen.kt
│   └── data/
│       └── DataStoreFactory.kt (expect)
├── androidMain/              # Android implementations
├── iosMain/                  # iOS implementations
├── jvmMain/                  # Desktop implementations
└── webMain/                  # Web implementations
```

## License

This implementation follows Sony's Camera Remote API documentation (archived). The API itself is deprecated but still functional on A7 III cameras.
