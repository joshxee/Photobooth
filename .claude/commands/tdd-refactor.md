---
description: Refactor code with test safety net
---

# Refactor Phase - Improve Code Quality Safely

In this phase, you improve code quality, structure, and design while keeping all tests green. Tests act as a safety net to ensure refactoring doesn't break existing behavior.

## Instructions

I will help you:

1. **Verify tests are passing** - Ensure we have a green baseline before refactoring
2. **Identify code smells** - Look for areas that need improvement
   - Duplication
   - Poor naming
   - Complex logic
   - Long functions or classes
   - Tight coupling
3. **Refactor incrementally** - Make small, focused improvements one at a time
4. **Run tests after each change** - Verify behavior is preserved
5. **Confirm final state** - All tests still pass, code is cleaner

## Common Refactoring Patterns

### Extract Function
Pull out duplicated or complex code into well-named functions:
```kotlin
// Before
fun processPhoto(photo: Photo) {
    val r = (photo.r * 0.299).toInt()
    val g = (photo.g * 0.587).toInt()
    val b = (photo.b * 0.114).toInt()
    // ...
}

// After
fun processPhoto(photo: Photo) {
    val grayscale = calculateWeightedGrayscale(photo)
    // ...
}

private fun calculateWeightedGrayscale(photo: Photo): Int {
    val r = (photo.r * 0.299).toInt()
    val g = (photo.g * 0.587).toInt()
    val b = (photo.b * 0.114).toInt()
    return r + g + b
}
```

### Rename for Clarity
Improve variable, function, and class names:
```kotlin
// Before
val c = counter.get()

// After
val photoCount = counter.getCurrentCount()
```

### Extract Constants
Replace magic numbers and strings:
```kotlin
// Before
fun calculateGrayscale(photo: Photo): Int {
    return (photo.r * 0.299 + photo.g * 0.587 + photo.b * 0.114).toInt()
}

// After
companion object {
    private const val RED_WEIGHT = 0.299
    private const val GREEN_WEIGHT = 0.587
    private const val BLUE_WEIGHT = 0.114
}

fun calculateGrayscale(photo: Photo): Int {
    return (photo.r * RED_WEIGHT +
            photo.g * GREEN_WEIGHT +
            photo.b * BLUE_WEIGHT).toInt()
}
```

### Simplify Conditionals
Reduce complexity with early returns or extraction:
```kotlin
// Before
fun processPhoto(photo: Photo?): Result {
    if (photo != null) {
        if (photo.isValid()) {
            return apply(photo)
        } else {
            return Result.Error("Invalid photo")
        }
    } else {
        return Result.Error("Photo is null")
    }
}

// After
fun processPhoto(photo: Photo?): Result {
    if (photo == null) return Result.Error("Photo is null")
    if (!photo.isValid()) return Result.Error("Invalid photo")
    return apply(photo)
}
```

### Extract Interface
Reduce coupling by depending on abstractions:
```kotlin
// Before
class PhotoProcessor {
    fun process(storage: FileStorage) {
        // Tightly coupled to FileStorage
    }
}

// After
interface Storage {
    fun save(data: ByteArray)
}

class PhotoProcessor {
    fun process(storage: Storage) {
        // Can work with any Storage implementation
    }
}
```

### Remove Dead Code
Delete unused code:
```kotlin
// Delete unused functions, parameters, or variables
// If tests still pass, the code wasn't needed!
```

## Best Practices

### Make ONE Change at a Time
- Refactor one thing, run tests, commit
- Don't batch multiple refactorings
- Easier to identify what broke if tests fail

### Run Tests Continuously
```bash
# Auto-run tests on every file change
./gradlew allTests --continuous
```
This gives immediate feedback if a refactoring breaks something!

### If Tests Fail, Revert
- If tests fail after a refactoring, revert the change
- Try a different approach or smaller steps
- Never commit broken tests

### Stop When Clean
- Don't over-engineer
- Code doesn't need to be perfect
- Stop when it's clear, simple, and maintainable

### Refactor Tests Too
Tests are code that needs maintenance:
- Remove duplication in test setup
- Extract test helpers
- Improve test naming
- Clean up test structure

## Running Tests

```bash
# Run all tests
./gradlew allTests --console=plain

# Run tests continuously (recommended!)
./gradlew allTests --continuous

# Run specific platform tests
./gradlew :composeApp:jvmTest
./gradlew :composeApp:jsTest
./gradlew :composeApp:wasmJsTest
```

## Code Smells to Look For

- **Duplication**: Same code in multiple places → Extract function
- **Long Functions**: Hard to understand → Break into smaller functions
- **Long Parameter Lists**: Too many parameters → Use parameter objects
- **Complex Conditionals**: Hard to follow → Simplify or extract
- **Magic Numbers**: Unexplained values → Extract constants
- **Poor Naming**: Unclear purpose → Rename
- **God Classes**: Does too much → Split responsibilities
- **Feature Envy**: Uses another class's data too much → Move method
- **Dead Code**: Unused code → Delete it

## After Refactoring

Once refactoring is complete and all tests are green:
- Commit your changes with a clear message
- Move on to the next feature with `/tdd-red`
- Or continue with more refactoring if needed

---

**Ready to refactor?** I'll help you improve code quality safely with your test suite as a safety net!
