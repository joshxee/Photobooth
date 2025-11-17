# Pragmatic Testing Guidelines

This project follows a **pragmatic testing approach** that prioritizes clean, modular, and testable code with comprehensive test coverage.

## Development Cycle

### 1. Implement - Build Clean, Testable Components

1. **Understand the requirement** - What feature needs to be built?
2. **Design for testability** - Plan components that are modular and easy to test
3. **Write clean implementation** - Focus on:
   - Single responsibility principle
   - Clear, descriptive naming
   - Minimal dependencies
   - Pure functions where possible
   - Proper separation of concerns

**Command**: `/tdd-red` (repurposed for implementation)

```kotlin
// Example: composeApp/src/commonMain/kotlin/PhotoCounter.kt
class PhotoCounter {
    private var photoCount = 0

    val count: Int
        get() = photoCount

    fun takePhoto() {
        photoCount++
    }

    fun reset() {
        photoCount = 0
    }
}
```

### 2. Test - Verify Component Behavior

1. **Component is complete** - Ensure the component is fully implemented
2. **Write comprehensive tests** - Cover all behaviors and edge cases
3. **Run tests** - Verify all tests pass
4. **Achieve good coverage** - Test happy paths, edge cases, and error conditions

**Command**: `/tdd-green` (repurposed for testing)

```kotlin
// Example: composeApp/src/commonTest/kotlin/PhotoCounterTest.kt
import kotlin.test.Test
import kotlin.test.assertEquals

class PhotoCounterTest {
    @Test
    fun shouldStartWithZeroCount() {
        val counter = PhotoCounter()

        assertEquals(0, counter.count)
    }

    @Test
    fun shouldIncrementCountWhenPhotoTaken() {
        val counter = PhotoCounter()

        counter.takePhoto()

        assertEquals(1, counter.count)
    }

    @Test
    fun shouldIncrementMultipleTimes() {
        val counter = PhotoCounter()

        counter.takePhoto()
        counter.takePhoto()
        counter.takePhoto()

        assertEquals(3, counter.count)
    }

    @Test
    fun shouldResetCountToZero() {
        val counter = PhotoCounter()
        counter.takePhoto()
        counter.takePhoto()

        counter.reset()

        assertEquals(0, counter.count)
    }
}
```

### 3. Refactor - Improve Quality

1. **All tests green?** - Don't refactor with failing tests!
2. **Identify improvements** - Look for code smells, duplication, complexity
3. **Make incremental changes** - One refactoring at a time
4. **Run tests after each change** - Immediate feedback on safety
5. **Stop when clean** - Don't over-engineer

**Command**: `/tdd-refactor`

```kotlin
// Example: Refactored version with better encapsulation
class PhotoCounter {
    private var _count = 0

    val count: Int
        get() = _count

    fun takePhoto() {
        incrementCount()
    }

    fun reset() {
        _count = 0
    }

    private fun incrementCount() {
        _count++
    }
}
```

## Why This Approach?

### Efficiency Benefits

- **No wasted test runs** - Tests only run against complete components
- **Fewer iterations** - No back-and-forth between test and implementation
- **Lower token usage** - Streamlined development process
- **Faster development** - Direct path from design to implementation to testing

### Quality Benefits

- **Clean code first** - Focus on good design from the start
- **Comprehensive testing** - Test all behaviors at once with full context
- **Testability by design** - Code is designed to be testable from the ground up
- **Strong test coverage** - Tests are written while implementation is fresh in mind

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
- After implementing and testing features
- Before committing code
- In CI/CD pipelines

### Continuous Testing (Watch Mode)

```bash
./gradlew allTests --continuous
```

**Great for development!** Tests auto-run whenever you save a file.

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

## Best Practices

### ✅ DO

- **Design for testability** - Think about how you'll test while implementing
- **Write clean, modular code** - Single responsibility, clear naming
- **Test immediately after implementing** - While the code is fresh
- **Test all behaviors** - Happy paths, edge cases, error conditions
- **Run tests frequently** - After writing tests and during refactoring
- **Use descriptive names** - `shouldReturnErrorWhenInputIsEmpty()`
- **Keep tests simple** - Tests should be easy to understand
- **Test behavior, not implementation** - Test what, not how
- **Commit when green** - Only commit passing tests

### ❌ DON'T

- **Don't skip tests** - Every component should have tests
- **Don't write untestable code** - If it's hard to test, redesign it
- **Don't write complex code** - Keep implementations simple and clear
- **Don't refactor with failing tests** - Always start from green
- **Don't test implementation details** - Test public behavior
- **Don't write complex tests** - If the test is complex, simplify it
- **Don't ignore failing tests** - Fix them immediately
- **Don't commit broken code** - Keep main branch green

## Example Workflow

Let's implement a photo filter feature:

### 1. Implement Phase

**Design the component:**
- Think about the interface
- Plan for testability (pure functions, dependency injection, etc.)
- Consider edge cases

```kotlin
// composeApp/src/commonMain/kotlin/filters/PhotoFilter.kt
interface PhotoFilter {
    fun apply(photo: Photo): Photo
}

data class Photo(val r: Int, val g: Int, val b: Int)

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

### 2. Test Phase

**Write comprehensive tests:**

```kotlin
// composeApp/src/commonTest/kotlin/filters/GrayscaleFilterTest.kt
import kotlin.test.Test
import kotlin.test.assertEquals

class GrayscaleFilterTest {
    @Test
    fun shouldApplyGrayscaleToColorPhoto() {
        val filter = GrayscaleFilter()
        val colorPhoto = Photo(r = 255, g = 100, b = 50)

        val filtered = filter.apply(colorPhoto)

        // Grayscale average: (255 + 100 + 50) / 3 = 135
        assertEquals(Photo(r = 135, g = 135, b = 135), filtered)
    }

    @Test
    fun shouldHandleBlackPhoto() {
        val filter = GrayscaleFilter()
        val blackPhoto = Photo(r = 0, g = 0, b = 0)

        val filtered = filter.apply(blackPhoto)

        assertEquals(Photo(r = 0, g = 0, b = 0), filtered)
    }

    @Test
    fun shouldHandleWhitePhoto() {
        val filter = GrayscaleFilter()
        val whitePhoto = Photo(r = 255, g = 255, b = 255)

        val filtered = filter.apply(whitePhoto)

        assertEquals(Photo(r = 255, g = 255, b = 255), filtered)
    }

    @Test
    fun shouldHandleAlreadyGrayscalePhoto() {
        val filter = GrayscaleFilter()
        val grayPhoto = Photo(r = 128, g = 128, b = 128)

        val filtered = filter.apply(grayPhoto)

        assertEquals(Photo(r = 128, g = 128, b = 128), filtered)
    }
}
```

**Run tests:** `./gradlew allTests` → ✅ ALL PASS

### 3. Refactor Phase (if needed)

**Improve code quality while keeping tests green:**

```kotlin
// Example: Extract weighted grayscale for better accuracy
class GrayscaleFilter : PhotoFilter {
    companion object {
        private const val RED_WEIGHT = 0.299
        private const val GREEN_WEIGHT = 0.587
        private const val BLUE_WEIGHT = 0.114
    }

    override fun apply(photo: Photo): Photo {
        val grayscale = calculateWeightedGrayscale(photo)
        return Photo(r = grayscale, g = grayscale, b = grayscale)
    }

    private fun calculateWeightedGrayscale(photo: Photo): Int {
        return (photo.r * RED_WEIGHT +
                photo.g * GREEN_WEIGHT +
                photo.b * BLUE_WEIGHT).toInt()
    }
}
```

**Update tests if behavior changed, or verify existing tests still pass.**

Run: `./gradlew allTests` → ✅ STILL PASSES

### 4. Repeat!

Next feature: Implement sepia filter → Start at Implement phase again!

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

## Development Slash Commands

Use these commands to guide your workflow:

- `/tdd-red` - Implement clean, testable components
- `/tdd-green` - Write tests for implemented components
- `/tdd-refactor` - Refactor code with test safety net
- `/test` - Run all tests
- `/test-watch` - Run tests continuously
- `/test-platform` - Run platform-specific tests

---

**Remember**: Implement → Test → Refactor → Repeat!
