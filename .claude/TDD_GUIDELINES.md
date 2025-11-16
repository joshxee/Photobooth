# Test-Driven Development (TDD) Guidelines

This project follows **Test-Driven Development** practices for all feature development.

## The TDD Cycle

### 🔴 RED - Write a Failing Test

1. **Understand the requirement** - What feature needs to be built?
2. **Write the test FIRST** - Before any implementation code
3. **Run the test** - It should FAIL (that's good!)
4. **Verify the failure** - Make sure it fails for the right reason

**Command**: `/tdd-red`

```kotlin
// Example: composeApp/src/commonTest/kotlin/PhotoCounterTest.kt
import kotlin.test.Test
import kotlin.test.assertEquals

class PhotoCounterTest {
    @Test
    fun shouldIncrementCountWhenPhotoTaken() {
        val counter = PhotoCounter()

        counter.takePhoto()

        assertEquals(1, counter.count)
    }
}
```

### 🟢 GREEN - Make It Pass

1. **Write minimal code** - Just enough to make the test pass
2. **No extra features** - Don't add things that aren't tested
3. **Run tests** - All tests should pass
4. **Verify success** - Confirm the new test passes

**Command**: `/tdd-green`

```kotlin
// Example: composeApp/src/commonMain/kotlin/PhotoCounter.kt
class PhotoCounter {
    var count = 0
        private set

    fun takePhoto() {
        count++  // Simplest implementation!
    }
}
```

### 🔵 REFACTOR - Improve Quality

1. **All tests green?** - Don't refactor with failing tests!
2. **Make small changes** - One refactoring at a time
3. **Run tests after each change** - Immediate feedback
4. **Stop when clean** - Don't over-engineer

**Command**: `/tdd-refactor`

```kotlin
// Example: Refactored version with better naming
class PhotoCounter {
    private var photoCount = 0

    val count: Int
        get() = photoCount

    fun takePhoto() {
        incrementCount()
    }

    private fun incrementCount() {
        photoCount++
    }
}
```

## Kotlin Multiplatform Test Structure

### Test Source Sets

```
composeApp/src/
├── commonMain/          # Shared production code
├── commonTest/          # ⭐ Shared tests (write here first!)
├── androidMain/         # Android-specific code
├── androidUnitTest/     # Android-specific tests
├── jvmMain/            # Desktop/JVM code
├── jvmTest/            # Desktop/JVM tests
├── jsMain/             # Web JS code
├── jsTest/             # Web JS tests
├── wasmJsMain/         # Web Wasm code
└── wasmJsTest/         # Web Wasm tests
```

### Best Practice: Start with commonTest

**Always write tests in `commonTest` first!** These tests run on ALL platforms.

Only use platform-specific tests when you need:
- Platform-specific APIs (Camera, GPS, etc.)
- Platform-specific behavior testing
- Integration with platform frameworks

## kotlin.test Library

Kotlin Multiplatform uses the `kotlin.test` library for cross-platform testing.

### Common Annotations

```kotlin
import kotlin.test.*

class MyTest {
    @BeforeTest
    fun setup() {
        // Runs before each test
    }

    @Test
    fun myTestFunction() {
        // Your test code
    }

    @AfterTest
    fun tearDown() {
        // Runs after each test
    }
}
```

### Assertions

```kotlin
// Equality
assertEquals(expected, actual)
assertEquals(expected, actual, "Custom message")
assertNotEquals(unexpected, actual)

// Boolean
assertTrue(condition)
assertFalse(condition)

// Nullability
assertNull(value)
assertNotNull(value)

// Exceptions
assertFailsWith<IllegalArgumentException> {
    // Code that should throw
}

// Contains
assertContains(collection, element)
assertContains("hello world", "world")

// Fails
fail("This should never be reached")
```

## Running Tests

### All Tests (Recommended)

```bash
./gradlew allTests
```

Runs tests on ALL platforms. Use this for:
- Before starting work (green baseline)
- After implementing features
- Before committing code
- In CI/CD pipelines

### Continuous Testing (Watch Mode)

```bash
./gradlew allTests --continuous
```

**Best for TDD!** Tests auto-run whenever you save a file.

**Command**: `/test-watch`

### Platform-Specific Tests

```bash
# Common tests only
./gradlew cleanAllTests

# Desktop/JVM
./gradlew :composeApp:jvmTest

# Android
./gradlew :composeApp:testDebugUnitTest

# Web JS
./gradlew :composeApp:jsTest

# Web Wasm
./gradlew :composeApp:wasmJsTest
```

**Command**: `/test-platform`

## TDD Best Practices

### ✅ DO

- **Write tests first** - Before any implementation code
- **One test at a time** - Focus on one behavior
- **Small steps** - Baby steps lead to success
- **Run tests frequently** - After every change
- **Test behavior, not implementation** - Test what, not how
- **Use descriptive names** - `shouldReturnErrorWhenInputIsEmpty()`
- **Keep tests simple** - Tests should be easy to understand
- **Test the happy path first** - Then edge cases
- **Commit when green** - Only commit passing tests

### ❌ DON'T

- **Don't skip the test** - No implementation without a test
- **Don't write multiple tests at once** - One at a time
- **Don't write production code without a failing test** - Red first!
- **Don't refactor with failing tests** - Always start from green
- **Don't test implementation details** - Test public behavior
- **Don't write complex tests** - If the test is complex, simplify it
- **Don't ignore failing tests** - Fix them immediately
- **Don't commit broken code** - Keep main branch green

## Example TDD Workflow

Let's implement a photo filter feature using TDD:

### 1. Red Phase 🔴

```kotlin
// composeApp/src/commonTest/kotlin/filters/PhotoFilterTest.kt
import kotlin.test.Test
import kotlin.test.assertEquals

class PhotoFilterTest {
    @Test
    fun shouldApplyGrayscaleFilter() {
        val filter = GrayscaleFilter()
        val colorPhoto = Photo(r = 255, g = 100, b = 50)

        val filtered = filter.apply(colorPhoto)

        // Grayscale average: (255 + 100 + 50) / 3 = 135
        assertEquals(Photo(r = 135, g = 135, b = 135), filtered)
    }
}
```

Run: `./gradlew allTests` → ❌ FAILS (no GrayscaleFilter class exists)

### 2. Green Phase 🟢

```kotlin
// composeApp/src/commonMain/kotlin/filters/GrayscaleFilter.kt
data class Photo(val r: Int, val g: Int, val b: Int)

class GrayscaleFilter {
    fun apply(photo: Photo): Photo {
        val gray = (photo.r + photo.g + photo.b) / 3
        return Photo(r = gray, g = gray, b = gray)
    }
}
```

Run: `./gradlew allTests` → ✅ PASSES

### 3. Refactor Phase 🔵

```kotlin
// Refactored with better abstraction
interface PhotoFilter {
    fun apply(photo: Photo): Photo
}

class GrayscaleFilter : PhotoFilter {
    override fun apply(photo: Photo): Photo {
        val grayscale = calculateGrayscale(photo)
        return Photo(r = grayscale, g = grayscale, b = grayscale)
    }

    private fun calculateGrayscale(photo: Photo): Int {
        return (photo.r + photo.g + photo.b) / 3
    }
}
```

Run: `./gradlew allTests` → ✅ STILL PASSES

### 4. Repeat!

Next feature: Add sepia filter → Start at Red phase again!

## Testing UI with Compose Multiplatform

For Compose UI testing, use `runComposeUiTest`:

```kotlin
import androidx.compose.ui.test.*

@Test
fun shouldDisplayPhotoCounterText() = runComposeUiTest {
    setContent {
        PhotoCounterScreen(count = 5)
    }

    onNodeWithText("Photos taken: 5").assertIsDisplayed()
}
```

## CI/CD Integration

Your CI pipeline should run:

```bash
./gradlew allTests check
```

This ensures:
- All tests pass on all platforms
- Code quality checks pass
- Build succeeds

## Resources

- [Kotlin Multiplatform Testing Docs](https://kotlinlang.org/docs/multiplatform-run-tests.html)
- [kotlin.test API Reference](https://kotlinlang.org/api/latest/kotlin.test/)
- [Compose Multiplatform UI Testing](https://kotlinlang.org/docs/compose-test.html)

## TDD Slash Commands

Use these commands to guide your TDD workflow:

- `/tdd-red` - Start with a failing test
- `/tdd-green` - Implement to make tests pass
- `/tdd-refactor` - Clean up code safely
- `/test` - Run all tests
- `/test-watch` - Run tests continuously
- `/test-platform` - Run platform-specific tests

---

**Remember**: Red → Green → Refactor → Repeat! 🔴🟢🔵🔁
