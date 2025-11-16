---
description: Build and run the web application
---

Build and run the web version of the Photobooth app.

Choose your target:

**Wasm (recommended - faster, modern browsers):**
```bash
./gradlew :composeApp:wasmJsBrowserDevelopmentRun
```

**JS (supports older browsers):**
```bash
./gradlew :composeApp:jsBrowserDevelopmentRun
```

The development server will start and open your browser automatically.
