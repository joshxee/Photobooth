# Architecture Overview

## High-Level Design

The Photobooth app follows a **layered architecture** optimized for Kotlin Multiplatform:

```
┌─────────────────────────────────────┐
│         UI Layer (Compose)          │
│  - Screens (Photobooth, PhotoStrip) │
│  - Platform-specific wrappers       │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      ViewModel Layer (Common)       │
│  - PhotoboothViewModel              │
│  - State management (StateFlow)     │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│     Domain Layer (Common)           │
│  - Models (PhotoData, Config)       │
│  - State classes (CaptureState)     │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│   Platform Layer (expect/actual)    │
│  - CameraController                 │
│  - PermissionHandler                │
└─────────────────────────────────────┘
```

## Key Architectural Decisions

### 1. Expect/Actual Pattern for Platform APIs

**Decision:** Use Kotlin Multiplatform's `expect`/`actual` pattern for camera and permissions.

**Reasoning:**
- Camera APIs are fundamentally platform-specific (CameraX on Android, AVFoundation on iOS, WebRTC on Web)
- Permissions systems differ significantly across platforms
- Allows common business logic in `commonMain` while keeping platform code isolated

**Implementation:**
```kotlin
// commonMain - Define interface
interface CameraController {
    suspend fun capturePhoto(): PhotoData
}

// androidMain - Android-specific implementation
class AndroidCameraController : CameraController {
    override suspend fun capturePhoto(): PhotoData {
        // CameraX implementation
    }
}
```

### 2. Compose Multiplatform for UI

**Decision:** Use Compose Multiplatform for all UI code.

**Reasoning:**
- Maximizes code sharing across platforms (Android, iOS, Desktop, Web)
- Single declarative UI paradigm
- Strong Material 3 support

**Trade-off:** Camera preview requires platform-specific composables (`CameraPreview`) but the surrounding UI is shared.

### 3. ViewModel + StateFlow for State Management

**Decision:** Use ViewModel with Kotlin StateFlow for reactive state management.

**Reasoning:**
- ViewModel survives configuration changes on Android
- StateFlow provides coroutine-based reactive streams
- Type-safe state updates
- Easy to test with coroutine test utilities

**Pattern:**
```kotlin
class PhotoboothViewModel : ViewModel() {
    private val _uiState = MutableStateFlow(PhotoboothUiState())
    val uiState: StateFlow<PhotoboothUiState> = _uiState.asStateFlow()
}
```

### 4. Sealed Classes for State Modeling

**Decision:** Use sealed classes for capture states.

**Reasoning:**
- Exhaustive when expressions (compile-time safety)
- Type-safe state-specific data
- Clear state machine transitions

**Example:**
```kotlin
sealed class CaptureState {
    object Idle : CaptureState()
    data class Countdown(val remainingSeconds: Int, ...) : CaptureState()
    data class Complete(val photos: List<PhotoData>) : CaptureState()
}
```

### 5. Suspend Functions for Async Operations

**Decision:** Use suspend functions instead of callbacks for camera operations.

**Reasoning:**
- Integrates naturally with coroutines in ViewModel
- Avoids callback hell
- Easier error handling with try/catch
- Prevents threading issues (original implementation had deadlock)

**Critical Fix:** Originally used blocking `Thread.sleep()` polling which caused main thread deadlock. Switched to `suspendCancellableCoroutine` for proper async behavior.

## Source Set Organization

```
commonMain/     # Shared code (models, ViewModels, UI logic)
commonTest/     # Shared tests (run on all platforms)
androidMain/    # Android-specific (CameraX, permissions)
iosMain/        # iOS-specific (placeholders for now)
jvmMain/        # Desktop-specific (placeholders)
jsMain/         # Web JS-specific (placeholders)
wasmJsMain/     # Web Wasm-specific (placeholders)
```

**Decision:** Put as much code as possible in `commonMain`, only use platform source sets when absolutely necessary.

## Navigation

**Current:** Simple enum-based screen navigation (`Screen.WELCOME`, `Screen.PHOTOBOOTH`, etc.)

**Decision:** Start simple with enum navigation, migrate to Compose Navigation library if complexity grows.

**Reasoning:**
- App currently has only 4 screens
- Enum approach is easier to test
- Can easily migrate later if needed

## Data Flow

```
User Action (UI)
    ↓
ViewModel (business logic)
    ↓
Platform Layer (camera/permissions)
    ↓
StateFlow update
    ↓
UI recomposition
```

All state updates flow through ViewModel → StateFlow → UI (unidirectional data flow).
