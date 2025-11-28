# State Management

## Overview

The app uses a unidirectional data flow pattern with ViewModel and Kotlin StateFlow.

## State Architecture

```
┌──────────────────┐
│  PhotoboothUI    │
│  (Composable)    │
└────────┬─────────┘
         │ observes
         ↓
┌──────────────────┐
│  StateFlow       │
│  <UiState>       │
└────────┬─────────┘
         ↑ updates
┌──────────────────┐
│  ViewModel       │
│  (Business Logic)│
└──────────────────┘
```

## State Classes

### PhotoboothUiState

**File:** `composeApp/src/commonMain/kotlin/com/jc/photobooth/ui/photobooth/PhotoboothUiState.kt`

```kotlin
data class PhotoboothUiState(
    val permissionState: PermissionState,
    val captureState: CaptureState,
    val config: PhotoboothConfig,
    val isPermissionRequested: Boolean
)
```

**Decision:** Single data class containing all screen state.

**Reasoning:**
- Single source of truth
- Atomic state updates
- Easy to snapshot for testing
- Type-safe

**Alternative Considered:** Multiple StateFlows (one per property). Rejected because:
- Harder to ensure consistent state
- More complex to test
- Potential race conditions

---

### CaptureState (Sealed Class)

**File:** `composeApp/src/commonMain/kotlin/com/jc/photobooth/ui/photobooth/CaptureState.kt`

```kotlin
sealed class CaptureState {
    object Idle : CaptureState()

    data class Countdown(
        val remainingSeconds: Int,
        val photoIndex: Int,
        val totalPhotos: Int
    ) : CaptureState()

    data class Capturing(val photoIndex: Int) : CaptureState()

    data class Complete(val photos: List<PhotoData>) : CaptureState()

    data class Error(val message: String) : CaptureState()
}
```

**Decision:** Use sealed class to model state machine.

**Benefits:**
- **Exhaustive when expressions** - Compiler ensures all states handled
- **Type-safe state data** - Each state has only relevant data
- **Clear transitions** - State changes are explicit

**State Machine:**
```
Idle → Countdown → Capturing → Countdown → ... → Complete
  ↓                                              ↓
  └──────────────────── Error ←─────────────────┘
```

**Why Not Enums?** Enums can't carry state-specific data (like `remainingSeconds`).

---

## ViewModel Implementation

### PhotoboothViewModel

**File:** `composeApp/src/commonMain/kotlin/com/jc/photobooth/ui/photobooth/PhotoboothViewModel.kt`

**Key Pattern:**
```kotlin
class PhotoboothViewModel(
    private val permissionHandler: CameraPermissionHandler,
    private val cameraController: CameraController,
    private val config: PhotoboothConfig
) : ViewModel() {

    private val _uiState = MutableStateFlow(PhotoboothUiState(config = config))
    val uiState: StateFlow<PhotoboothUiState> = _uiState.asStateFlow()

    fun startCaptureSequence() {
        viewModelScope.launch {
            // Business logic with suspend functions
        }
    }
}
```

**Decision Points:**

#### 1. MutableStateFlow (Private) + StateFlow (Public)

**Reasoning:**
- UI can only observe, not modify
- All updates go through ViewModel methods
- Single source of truth

#### 2. ViewModelScope for Coroutines

```kotlin
viewModelScope.launch {
    // Coroutine automatically cancelled when ViewModel cleared
}
```

**Reasoning:**
- Lifecycle-aware (auto-cancels on screen exit)
- No memory leaks
- Structured concurrency

#### 3. Dependency Injection via Constructor

**Decision:** Pass dependencies (camera, permissions) as constructor parameters.

**Reasoning:**
- Testable (easy to inject mocks)
- Explicit dependencies
- No hidden dependencies or service locators

**Future:** Could add Koin or other DI framework if app grows.

---

## State Update Pattern

**Always use `.update { }` for atomic updates:**

```kotlin
_uiState.update { currentState ->
    currentState.copy(captureState = CaptureState.Capturing(index))
}
```

**Why `.update { }` instead of `.value = `?**
- Thread-safe
- Guaranteed to see latest state
- Handles concurrent updates correctly

---

## Capture Sequence Logic

**Implementation:**
```kotlin
fun startCaptureSequence() {
    viewModelScope.launch {
        try {
            val photos = mutableListOf<PhotoData>()

            repeat(config.numberOfPhotos) { index ->
                // Countdown
                for (countdown in config.countdownSeconds downTo 1) {
                    _uiState.update {
                        it.copy(captureState = CaptureState.Countdown(...))
                    }
                    delay(1000L)
                }

                // Capture
                _uiState.update { it.copy(captureState = CaptureState.Capturing(...)) }
                val photo = cameraController.capturePhoto()  // suspend
                photos.add(photo)

                // Brief pause
                delay(500L)
            }

            // Complete
            _uiState.update {
                it.copy(captureState = CaptureState.Complete(photos))
            }
        } catch (e: Exception) {
            _uiState.update {
                it.copy(captureState = CaptureState.Error(e.message ?: "Unknown error"))
            }
        }
    }
}
```

**Decision:** Sequential photo capture with coroutine delays.

**Why Sequential?**
- Gives clear visual feedback (countdown for each photo)
- Avoids overwhelming camera with simultaneous captures
- Simpler error handling

**Why Coroutine `delay()` Not `Thread.sleep()`?**
- Non-blocking (main thread stays responsive)
- Cancellable if user exits screen
- Integrates with suspend functions

---

## Permission State Handling

**Pattern:**
```kotlin
when {
    !uiState.permissionState.isGranted -> {
        PermissionDeniedContent(...)
    }
    else -> {
        CameraPreviewContent(...)
    }
}
```

**Decision:** Handle permissions at UI level, not in ViewModel.

**Reasoning:**
- Permission dialogs are UI concerns
- ViewModel stays platform-agnostic
- Easier to test UI states independently

---

## Error Handling

**Current:** Simple error messages in `CaptureState.Error`.

**Decision:** Start with string-based errors, can refactor to sealed error classes if needed.

```kotlin
data class Error(val message: String) : CaptureState()
```

**Future Enhancement:**
```kotlin
sealed class PhotoboothError {
    object CameraUnavailable : PhotoboothError()
    object PermissionDenied : PhotoboothError()
    data class CaptureFailure(val reason: String) : PhotoboothError()
}

data class Error(val error: PhotoboothError) : CaptureState()
```

**When to Refactor:** If we need:
- Different UI for different error types
- Retry logic based on error type
- Error analytics

---

## Testing State Management

**Approach:** Use Kotlin coroutines test utilities.

```kotlin
@OptIn(ExperimentalCoroutinesApi::class)
class PhotoboothViewModelTest {
    private val testDispatcher = StandardTestDispatcher()

    @BeforeTest
    fun setup() {
        Dispatchers.setMain(testDispatcher)
    }

    @Test
    fun `test state transitions`() = runTest {
        viewModel.startCaptureSequence()

        testDispatcher.scheduler.advanceTimeBy(1000)
        assertTrue(viewModel.uiState.value.captureState is CaptureState.Countdown)

        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.uiState.value.captureState is CaptureState.Complete)
    }
}
```

**Key:** Use `TestDispatcher` to control time and make tests deterministic.

---

## State Persistence

**Current:** No state persistence (state lost on app restart).

**Future Consideration:** If needed, could add:
```kotlin
private val savedStateHandle: SavedStateHandle

val uiState: StateFlow<PhotoboothUiState> =
    savedStateHandle.getStateFlow("ui_state", initial)
```

**Decision:** Skip for now - photobooth sessions are ephemeral.
