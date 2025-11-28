---
description: Implement clean, testable components
---

# Implementation Phase - Build Clean, Testable Code

In this phase, you write clean, modular, and testable implementation code for a feature or component.

## Instructions

I will help you:

1. **Understand the requirement** - What feature are you implementing?
2. **Design for testability** - Plan the component structure
   - Identify inputs, outputs, and dependencies
   - Consider pure functions and minimal side effects
   - Plan for dependency injection if needed
3. **Implement the component** - Write clean, production-ready code
   - Follow single responsibility principle
   - Use clear, descriptive naming
   - Keep functions small and focused
   - Separate concerns appropriately
4. **Prepare for testing** - Ensure the component is complete and ready to be tested

## Design Principles

### Clean Code
- Single Responsibility: Each class/function should do one thing well
- Clear Naming: Names should reveal intent
- Small Functions: Functions should be short and focused
- Minimal Dependencies: Reduce coupling where possible

### Testability
- Pure Functions: Same input → same output (no side effects)
- Dependency Injection: Pass dependencies as parameters
- Interface Segregation: Depend on abstractions, not concrete implementations
- Avoid Global State: Make dependencies explicit

## Location

- **Cross-platform code**: `composeApp/src/commonMain/kotlin/`
- **Android-specific**: `composeApp/src/androidMain/kotlin/`
- **Desktop/JVM**: `composeApp/src/jvmMain/kotlin/`
- **Web**: `composeApp/src/jsMain/kotlin/` or `wasmJsMain/kotlin/`

**Prefer commonMain** for maximum code sharing!

## Example

```kotlin
// composeApp/src/commonMain/kotlin/domain/PhotoCounter.kt
package domain

/**
 * Tracks the number of photos taken in a session.
 * This is a simple, testable component with clear behavior.
 */
class PhotoCounter {
    private var _count = 0

    val count: Int
        get() = _count

    fun takePhoto() {
        _count++
    }

    fun reset() {
        _count = 0
    }
}
```

## After Implementation

Once the component is implemented, use `/tdd-green` to write comprehensive tests for it.

---

**Ready to implement?** Tell me what feature you want to build and I'll help you create a clean, testable component!
