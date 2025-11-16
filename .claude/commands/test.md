---
description: Run all tests for the project
---

Run all tests across all platforms for the Photobooth app.

```bash
./gradlew test --console=plain
```

To run tests for a specific target:
- All tests: `./gradlew test`
- Common tests: `./gradlew :composeApp:cleanAllTests`
- Android tests: `./gradlew :composeApp:testDebugUnitTest`
- Desktop tests: `./gradlew :composeApp:jvmTest`
