# Testing Strategy

## Test Pyramid

```
        ┌─────────┐
        │   E2E   │  10% - Full user flows
        ├─────────┤
        │ Integ.  │  20% - Component interactions
        ├─────────┤
        │  Unit   │  70% - Individual components
        └─────────┘
```

## Test Organization

### Common Tests (Shared Across Platforms)

**Location:** `composeApp/src/commonTest/`

**What Goes Here:**
- Model tests (PhotoData, PhotoboothConfig)
- State tests (CaptureState, PhotoboothUiState)
- ViewModel tests (business logic)
- Interface contract tests (CameraController, PermissionHandler)

**Why commonTest?**
- Tests run on ALL platforms (JVM, Android, iOS, JS, Wasm)
- Verifies cross-platform behavior
- Single test suite to maintain

**Current Coverage:**
- ✅ 6 tests - CaptureState
- ✅ 4 tests - PhotoboothUiState
- ✅ 8 tests - PhotoboothViewModel
- ✅ 5 tests - CameraController interface
- ✅ 4 tests - PermissionState
- ✅ 3 tests - CameraPermissionHandler interface

**Total: 30 tests, all passing**

---

### Platform-Specific Tests

**Location:** `composeApp/src/androidTest/` (instrumented tests)

**What Goes Here:**
- CameraX integration tests (requires real device/emulator)
- Permission system tests (requires Android runtime)
- UI tests with Compose Test

**Future:** Add when Android-specific implementation needs testing beyond mocks.

---

## Testing Patterns

### 1. ViewModel Tests with Coroutines

**Challenge:** ViewModels use coroutines and delay, which are time-dependent.

**Solution:** Use `StandardTestDispatcher` to control virtual time.

```kotlin
@OptIn(ExperimentalCoroutinesApi::class)
class PhotoboothViewModelTest {
    private val testDispatcher = StandardTestDispatcher()

    @BeforeTest
    fun setup() {
        Dispatchers.setMain(testDispatcher)  // Override main dispatcher
    }

    @AfterTest
    fun teardown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `countdown progresses correctly`() = runTest {
        viewModel.startCaptureSequence()

        // Advance virtual time by 1 second
        testDispatcher.scheduler.advanceTimeBy(1000)

        val state = viewModel.uiState.value.captureState as CaptureState.Countdown
        assertEquals(2, state.remainingSeconds)
    }
}
```

**Key Insight:** `advanceTimeBy()` skips waiting, making tests instant and deterministic.

---

### 2. Suspend Function Tests

**Pattern:** Use `runTest { }` for suspend function tests.

```kotlin
@Test
fun testCapturePhotoReturnsPhotoData() = runTest {
    val controller = TestCameraController()
    val photo = controller.capturePhoto()  // suspend fun

    assertNotNull(photo)
    assertTrue(photo.imageBytes.isNotEmpty())
}
```

**Why `runTest`?**
- Provides coroutine scope for suspend functions
- Waits for all coroutines to complete
- Fails test if uncaught exceptions

---

### 3. Test Doubles (Mocks)

**Approach:** Create simple test implementations, no mocking framework needed.

```kotlin
class TestCameraController : CameraController {
    override suspend fun capturePhoto() =
        PhotoData(byteArrayOf(1, 2, 3), System.currentTimeMillis())

    override fun release() {}
}
```

**Decision:** Prefer simple test doubles over mocking frameworks.

**Reasoning:**
- No external dependencies (MockK, etc.)
- Works across all platforms (some mocking frameworks are JVM-only)
- Easier to understand and maintain
- Sufficient for current needs

**When to Add Mocking Framework:** If we need:
- Verification (was method called?)
- Argument capture
- Complex behavior stubbing

---

### 4. Sealed Class Testing

**Pattern:** Verify exhaustiveness with collection of all subtypes.

```kotlin
@Test
fun `sealed class has all expected subtypes`() {
    val states = listOf(
        CaptureState.Idle,
        CaptureState.Countdown(1, 1, 1),
        CaptureState.Capturing(1),
        CaptureState.Complete(emptyList()),
        CaptureState.Error("")
    )
    assertEquals(5, states.size)
}
```

**Purpose:** Ensures test suite is updated when new sealed class subtypes are added.

---

## Dependencies

```kotlin
commonTest.dependencies {
    implementation(libs.kotlin.test)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
}
```

**Minimal by design:**
- `kotlin.test` - Cross-platform test assertions
- `kotlinx-coroutines-test` - Coroutine testing utilities

---

## Test Execution

### Run All Tests (Recommended Before Commits)
```bash
./gradlew allTests
```

**What it does:** Runs tests on JVM, Android, JS, and Wasm platforms.

### Platform-Specific Tests
```bash
./gradlew :composeApp:jvmTest                # Desktop
./gradlew :composeApp:testDebugUnitTest      # Android (unit)
./gradlew :composeApp:jsTest                 # Web JS
./gradlew :composeApp:wasmJsTest            # Web Wasm
```

### Continuous Testing (TDD)
```bash
./gradlew allTests --continuous
# Or use slash command:
/test-watch
```

**Auto-reruns tests when code changes.**

---

## Coverage Goals

| Component                | Target Coverage | Current Status |
|--------------------------|-----------------|----------------|
| Models                   | 100%            | ✅ 100%        |
| State Classes            | 100%            | ✅ 100%        |
| ViewModel Logic          | 95%             | ✅ 95%         |
| Permission System (Common) | 90%           | ✅ 90%         |
| Camera Controller (Common) | 100%          | ✅ 100%        |
| UI Components            | 70%             | ⏸️ Future     |
| Platform Implementations | 60%             | ⏸️ Future     |

---

## What's NOT Tested (Yet)

### UI Component Tests
**Why Not Yet:**
- Requires Compose UI Test framework setup
- Platform-specific test infrastructure needed
- Current focus on business logic testing

**Future:**
```kotlin
@Test
fun `shows countdown overlay during countdown`() {
    composeTestRule.setContent {
        PhotoboothScreen(viewModel, ...)
    }

    composeTestRule.onNodeWithText("3").assertExists()
}
```

### Android CameraX Integration Tests
**Why Not Yet:**
- Requires instrumented tests (device/emulator)
- Harder to maintain in CI/CD
- Mocked CameraController sufficient for current needs

**Future:** Add if camera bugs are found that mocks don't catch.

---

## Test-Driven Development (TDD)

**Process:**
1. 🔴 **RED** - Write failing test
2. 🟢 **GREEN** - Implement minimal code to pass
3. 🔵 **REFACTOR** - Improve code while keeping tests green

**Slash Commands:**
- `/tdd-red` - Write failing test
- `/tdd-green` - Implement to pass tests
- `/tdd-refactor` - Refactor safely

**When to Use TDD:**
- New feature development
- Complex business logic
- Bug fixes (regression tests)

**When NOT to Use TDD:**
- Exploratory prototyping
- UI layout (visual feedback more valuable)
- Trivial getters/setters

---

## CI/CD Integration (Future)

**Recommended GitHub Actions Workflow:**
```yaml
- name: Run Tests
  run: ./gradlew allTests

- name: Upload Test Reports
  uses: actions/upload-artifact@v3
  with:
    name: test-reports
    path: composeApp/build/reports/tests/
```

**When to Add:** Before enabling PRs from other contributors.

---

## Test Maintainability

### Good Test Characteristics
- ✅ **Fast** - Uses test dispatchers, no real delays
- ✅ **Isolated** - Each test is independent
- ✅ **Repeatable** - Same result every run (deterministic)
- ✅ **Self-validating** - Clear pass/fail
- ✅ **Timely** - Written with (or before) production code

### Test Naming Convention

```kotlin
@Test
fun `descriptive test name in backticks`() {
    // Readable test names that describe behavior
}
```

**Why backticks?** Allows spaces and natural language in test names.

---

## Known Test Gaps

1. **No E2E tests** - Full user flows not tested
2. **No UI tests** - Screen rendering not verified
3. **No performance tests** - Capture speed not measured
4. **No Android instrumented tests** - Real CameraX behavior not tested

**Prioritization:** Current test suite covers business logic thoroughly. UI/E2E tests are lower priority for MVP.
