---
description: Run Compose UI tests
---

# Run Compose Multiplatform UI Tests

Run UI tests for Compose Multiplatform components across platforms.

## Compose UI Testing Framework

Compose Multiplatform uses `runComposeUiTest` function instead of JUnit's TestRule.

### Example Test

```kotlin
import androidx.compose.ui.test.*

@Test
fun shouldDisplayWelcomeText() = runComposeUiTest {
    setContent {
        WelcomeScreen()
    }

    onNodeWithText("Welcome to Photobooth").assertIsDisplayed()
}
```

## Running UI Tests

### All Platform UI Tests
```bash
./gradlew allTests
```

### Desktop/JVM UI Tests
```bash
./gradlew :composeApp:jvmTest
```

### Android Instrumented Tests
```bash
# Requires connected device or emulator
./gradlew :composeApp:connectedAndroidTest
```

### iOS Simulator Tests
```bash
./gradlew :composeApp:iosSimulatorArm64Test
```

### Web/Wasm Tests
```bash
./gradlew :composeApp:wasmJsTest
```

## UI Test Components

### Finders
Locate UI elements:
- `onNodeWithText("Hello")` - Find by text
- `onNodeWithTag("button")` - Find by test tag
- `onNodeWithContentDescription("Icon")` - Find by accessibility label
- `onAllNodesWithText("Item")` - Find multiple nodes

### Assertions
Verify element properties:
- `assertIsDisplayed()` - Element is visible
- `assertTextEquals("Expected")` - Text matches
- `assertExists()` - Element exists in tree
- `assertDoesNotExist()` - Element not in tree
- `assertIsEnabled()` / `assertIsNotEnabled()` - Enabled state

### Actions
Simulate user interactions:
- `performClick()` - Click element
- `performTextInput("text")` - Type text
- `performScrollTo()` - Scroll to element
- `performTouchInput { ... }` - Custom touch gestures

## Adding Test Tags

Use Modifier.testTag() for reliable element finding:

```kotlin
@Composable
fun PhotoButton() {
    Button(
        onClick = { /* ... */ },
        modifier = Modifier.testTag("take-photo-button")
    ) {
        Text("Take Photo")
    }
}
```

Then in tests:
```kotlin
@Test
fun shouldEnablePhotoButton() = runComposeUiTest {
    setContent { PhotoButton() }

    onNodeWithTag("take-photo-button")
        .assertIsDisplayed()
        .assertIsEnabled()
}
```

## Best Practices

1. **Test in commonTest** - Write UI tests that work on all platforms
2. **Use test tags** - More reliable than text-based finders
3. **Test user flows** - Test complete interactions, not individual components
4. **Keep tests focused** - One assertion per test when possible
5. **Use descriptive names** - `shouldDisplayErrorWhenUsernameIsEmpty()`

## TDD with UI Tests

Follow the Red-Green-Refactor cycle:

1. **🔴 RED**: Write failing UI test
   ```kotlin
   @Test
   fun shouldShowPhotoCountAfterCapture() = runComposeUiTest {
       setContent { PhotoScreen() }
       onNodeWithText("Photos: 0").assertIsDisplayed()
       onNodeWithTag("take-photo-button").performClick()
       onNodeWithText("Photos: 1").assertIsDisplayed()
   }
   ```

2. **🟢 GREEN**: Implement minimal UI code to pass

3. **🔵 REFACTOR**: Clean up composables while tests stay green

## Important Notes

- The Compose UI testing API is **experimental** and may change
- Android instrumented tests require a connected device or emulator
- Desktop supports both Compose UI tests and traditional JUnit tests

---

**Ready to test your UI?** I'll help you write comprehensive Compose UI tests!
