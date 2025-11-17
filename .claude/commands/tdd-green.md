---
description: Write tests for implemented components
---

# Testing Phase - Verify Component Behavior

In this phase, you write comprehensive tests for a completed component to ensure it works correctly.

## Instructions

I will help you:

1. **Review the implementation** - Understand the component's behavior and responsibilities
2. **Identify test cases** - What scenarios should be tested?
   - Happy path (normal usage)
   - Edge cases (boundary conditions)
   - Error cases (invalid inputs, exceptional conditions)
   - State transitions (if applicable)
3. **Write comprehensive tests** - Cover all identified scenarios
4. **Run the tests** - Verify all tests pass
5. **Review coverage** - Ensure critical behaviors are tested

## Test Writing Best Practices

### Structure
- **Arrange**: Set up test data and preconditions
- **Act**: Execute the behavior being tested
- **Assert**: Verify the expected outcome

### Naming
Use descriptive test names that explain the behavior:
- `shouldReturnEmptyListWhenNoPhotosExist()`
- `shouldIncrementCountWhenPhotoTaken()`
- `shouldThrowExceptionWhenInputIsNull()`

### Coverage
Test these categories:
- **Happy Path**: Normal, expected usage
- **Edge Cases**: Boundary values (0, max, negative)
- **Error Cases**: Invalid inputs, null values
- **State**: Different initial states leading to different outcomes

## Test Location

- **Cross-platform tests**: `composeApp/src/commonTest/kotlin/`
- **Android-specific**: `composeApp/src/androidUnitTest/kotlin/`
- **Desktop/JVM**: `composeApp/src/jvmTest/kotlin/`
- **Web**: `composeApp/src/jsTest/kotlin/` or `wasmJsTest/kotlin/`

**Prefer commonTest** to test code that runs on all platforms!

## Example

```kotlin
// composeApp/src/commonTest/kotlin/domain/PhotoCounterTest.kt
package domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.BeforeTest

class PhotoCounterTest {
    private lateinit var counter: PhotoCounter

    @BeforeTest
    fun setup() {
        counter = PhotoCounter()
    }

    @Test
    fun shouldStartWithZeroCount() {
        assertEquals(0, counter.count)
    }

    @Test
    fun shouldIncrementCountWhenPhotoTaken() {
        counter.takePhoto()

        assertEquals(1, counter.count)
    }

    @Test
    fun shouldIncrementMultipleTimes() {
        counter.takePhoto()
        counter.takePhoto()
        counter.takePhoto()

        assertEquals(3, counter.count)
    }

    @Test
    fun shouldResetCountToZero() {
        counter.takePhoto()
        counter.takePhoto()

        counter.reset()

        assertEquals(0, counter.count)
    }

    @Test
    fun shouldMaintainCountAfterMultipleResets() {
        counter.takePhoto()
        counter.reset()
        counter.takePhoto()
        counter.takePhoto()

        assertEquals(2, counter.count)
    }
}
```

## Running Tests

```bash
# Run all tests (recommended)
./gradlew allTests --console=plain

# Run tests continuously (great during development)
./gradlew allTests --continuous

# Run specific platform tests
./gradlew :composeApp:jvmTest        # Desktop/JVM
./gradlew :composeApp:jsTest         # Web JS
./gradlew :composeApp:wasmJsTest     # Web Wasm
./gradlew :composeApp:testDebugUnitTest  # Android
```

## kotlin.test Assertions

```kotlin
import kotlin.test.*

// Equality
assertEquals(expected, actual)
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

// Collections
assertContains(collection, element)
assertContentEquals(expected, actual)  // Deep equality

// Custom message
assertEquals(expected, actual, "Custom failure message")
```

## After Testing

Once all tests pass:
- If code needs improvement, use `/tdd-refactor` to clean it up safely
- If ready to move on, implement the next feature with `/tdd-red`

---

**Ready to write tests?** I'll help you write comprehensive tests for your implemented components!
