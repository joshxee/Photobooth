# Graph Report - .  (2026-05-06)

## Corpus Check
- 198 files · ~60,071 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 978 nodes · 1093 edges · 147 communities (82 shown, 65 thin omitted)
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 133 edges (avg confidence: 0.8)
- Token cost: 158,606 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Sony Camera JSON-RPC Client|Sony Camera JSON-RPC Client]]
- [[_COMMUNITY_Photobooth Config & Native ViewModel|Photobooth Config & Native ViewModel]]
- [[_COMMUNITY_Photobooth UI Overlays|Photobooth UI Overlays]]
- [[_COMMUNITY_Sony Mark2 Capture State Machine|Sony Mark2 Capture State Machine]]
- [[_COMMUNITY_Camera Domain Interface|Camera Domain Interface]]
- [[_COMMUNITY_Android Platform Factories|Android Platform Factories]]
- [[_COMMUNITY_App Shell & Settings UI|App Shell & Settings UI]]
- [[_COMMUNITY_Sony API Discovery|Sony API Discovery]]
- [[_COMMUNITY_Camera Repository|Camera Repository]]
- [[_COMMUNITY_Sony Mark2 Tests|Sony Mark2 Tests]]
- [[_COMMUNITY_Mock Camera Test Doubles|Mock Camera Test Doubles]]
- [[_COMMUNITY_PhotoData Model|PhotoData Model]]
- [[_COMMUNITY_Photo Strip ViewModel|Photo Strip ViewModel]]
- [[_COMMUNITY_Camera System Documentation|Camera System Documentation]]
- [[_COMMUNITY_CameraController Tests|CameraController Tests]]
- [[_COMMUNITY_Permission State Tests|Permission State Tests]]
- [[_COMMUNITY_State Management Patterns|State Management Patterns]]
- [[_COMMUNITY_Android CameraController|Android CameraController]]
- [[_COMMUNITY_Camera Network Monitor|Camera Network Monitor]]
- [[_COMMUNITY_Photo Strip Tests|Photo Strip Tests]]
- [[_COMMUNITY_App Common Tests|App Common Tests]]
- [[_COMMUNITY_Camera Permission Tests|Camera Permission Tests]]
- [[_COMMUNITY_WiFi Connection Manager|WiFi Connection Manager]]
- [[_COMMUNITY_Android CameraX Rationale|Android CameraX Rationale]]
- [[_COMMUNITY_Build & Entry Points|Build & Entry Points]]
- [[_COMMUNITY_Cluster 25|Cluster 25]]
- [[_COMMUNITY_Cluster 26|Cluster 26]]
- [[_COMMUNITY_Cluster 27|Cluster 27]]
- [[_COMMUNITY_Cluster 28|Cluster 28]]
- [[_COMMUNITY_Cluster 29|Cluster 29]]
- [[_COMMUNITY_Cluster 30|Cluster 30]]
- [[_COMMUNITY_Cluster 31|Cluster 31]]
- [[_COMMUNITY_Cluster 32|Cluster 32]]
- [[_COMMUNITY_Cluster 33|Cluster 33]]
- [[_COMMUNITY_Cluster 34|Cluster 34]]
- [[_COMMUNITY_Cluster 35|Cluster 35]]
- [[_COMMUNITY_Cluster 36|Cluster 36]]
- [[_COMMUNITY_Cluster 37|Cluster 37]]
- [[_COMMUNITY_Cluster 38|Cluster 38]]
- [[_COMMUNITY_Cluster 39|Cluster 39]]
- [[_COMMUNITY_Cluster 40|Cluster 40]]
- [[_COMMUNITY_Cluster 41|Cluster 41]]
- [[_COMMUNITY_Cluster 42|Cluster 42]]
- [[_COMMUNITY_Cluster 43|Cluster 43]]
- [[_COMMUNITY_Cluster 44|Cluster 44]]
- [[_COMMUNITY_Cluster 45|Cluster 45]]
- [[_COMMUNITY_Cluster 46|Cluster 46]]
- [[_COMMUNITY_Cluster 47|Cluster 47]]
- [[_COMMUNITY_Cluster 48|Cluster 48]]
- [[_COMMUNITY_Cluster 49|Cluster 49]]
- [[_COMMUNITY_Cluster 50|Cluster 50]]
- [[_COMMUNITY_Cluster 51|Cluster 51]]
- [[_COMMUNITY_Cluster 52|Cluster 52]]
- [[_COMMUNITY_Cluster 53|Cluster 53]]
- [[_COMMUNITY_Cluster 54|Cluster 54]]
- [[_COMMUNITY_Cluster 55|Cluster 55]]
- [[_COMMUNITY_Cluster 56|Cluster 56]]
- [[_COMMUNITY_Cluster 57|Cluster 57]]
- [[_COMMUNITY_Cluster 58|Cluster 58]]
- [[_COMMUNITY_Cluster 59|Cluster 59]]
- [[_COMMUNITY_Cluster 60|Cluster 60]]
- [[_COMMUNITY_Cluster 61|Cluster 61]]
- [[_COMMUNITY_Cluster 62|Cluster 62]]
- [[_COMMUNITY_Cluster 63|Cluster 63]]
- [[_COMMUNITY_Cluster 64|Cluster 64]]
- [[_COMMUNITY_Cluster 65|Cluster 65]]
- [[_COMMUNITY_Cluster 66|Cluster 66]]
- [[_COMMUNITY_Cluster 67|Cluster 67]]
- [[_COMMUNITY_Cluster 68|Cluster 68]]
- [[_COMMUNITY_Cluster 69|Cluster 69]]
- [[_COMMUNITY_Cluster 70|Cluster 70]]
- [[_COMMUNITY_Cluster 71|Cluster 71]]
- [[_COMMUNITY_Cluster 72|Cluster 72]]
- [[_COMMUNITY_Cluster 73|Cluster 73]]
- [[_COMMUNITY_Cluster 74|Cluster 74]]
- [[_COMMUNITY_Cluster 75|Cluster 75]]
- [[_COMMUNITY_Cluster 76|Cluster 76]]
- [[_COMMUNITY_Cluster 77|Cluster 77]]
- [[_COMMUNITY_Cluster 79|Cluster 79]]
- [[_COMMUNITY_Cluster 81|Cluster 81]]
- [[_COMMUNITY_Cluster 82|Cluster 82]]
- [[_COMMUNITY_Cluster 83|Cluster 83]]
- [[_COMMUNITY_Cluster 84|Cluster 84]]
- [[_COMMUNITY_Cluster 98|Cluster 98]]
- [[_COMMUNITY_Cluster 100|Cluster 100]]
- [[_COMMUNITY_Cluster 141|Cluster 141]]
- [[_COMMUNITY_Cluster 142|Cluster 142]]
- [[_COMMUNITY_Cluster 143|Cluster 143]]
- [[_COMMUNITY_Cluster 144|Cluster 144]]
- [[_COMMUNITY_Cluster 145|Cluster 145]]
- [[_COMMUNITY_Cluster 146|Cluster 146]]

## God Nodes (most connected - your core abstractions)
1. `SonyMark2ViewModel` - 24 edges
2. `SonyCameraApiClient` - 23 edges
3. `PhotoData` - 20 edges
4. `SonyMark2ViewModelTest` - 19 edges
5. `PhotoboothViewModel` - 18 edges
6. `SonyA7IIICamera` - 16 edges
7. `PhotoboothConfig` - 16 edges
8. `MockPhotoboothCamera` - 16 edges
9. `SonyApiDiscoveryService` - 15 edges
10. `PhotoStripViewModelTest` - 14 edges

## Surprising Connections (you probably didn't know these)
- `composeApp.js Loader Script` --references--> `composeApp Module`  [INFERRED]
  composeApp/src/webMain/resources/index.html → README.md
- `expect/actual Pattern for Platform APIs` --rationale_for--> `ImageBitmapEncoder (expect/actual)`  [INFERRED]
  wiki/Architecture.md → wiki/Camera-System.md
- `PhotoboothViewModel` --semantically_similar_to--> `SonyMark2ViewModel`  [INFERRED] [semantically similar]
  wiki/State-Management.md → wiki/Camera-System.md
- `App()` --calls--> `PhotoboothTheme()`  [INFERRED]
  composeApp/src/commonMain/kotlin/com/jc/photobooth/App.kt → composeApp/src/commonMain/kotlin/com/jc/photobooth/ui/theme/PhotoboothTheme.kt
- `App()` --calls--> `CameraRepository`  [INFERRED]
  composeApp/src/commonMain/kotlin/com/jc/photobooth/App.kt → composeApp/src/commonMain/kotlin/com/jc/photobooth/camera/domain/CameraRepository.kt

## Hyperedges (group relationships)
- **Sony Mark 2.0 Capture Pipeline** — camera_system_sony_mark2_view_model, camera_system_sony_camera_api_client, camera_system_act_take_picture, camera_system_camera_network_monitor [EXTRACTED 1.00]
- **ViewModel + StateFlow + Sealed CaptureState Pattern** — state_management_photobooth_view_model, state_management_photobooth_ui_state, state_management_capture_state, architecture_unidirectional_data_flow [EXTRACTED 1.00]
- **expect/actual KMP Platform Abstractions** — architecture_expect_actual_pattern, architecture_camera_controller_interface, camera_system_image_bitmap_encoder, camera_system_wifi_connection_manager, camera_system_fullscreen_effect [EXTRACTED 1.00]

## Communities (147 total, 65 thin omitted)

### Community 0 - "Sony Camera JSON-RPC Client"
Cohesion: 0.07
Nodes (12): CameraEvent, CaptureWorkflowResult, CaptureWorkflowStep, JsonRpcError, JsonRpcErrorSerializer, JsonRpcRequest, JsonRpcResponse, NoOpLogger (+4 more)

### Community 1 - "Photobooth Config & Native ViewModel"
Cohesion: 0.06
Nodes (7): PhotoboothConfig, PhotoboothConfigTest, PhotoboothScreenWrapper(), PhotoboothViewModel, PhotoboothViewModelTest, TestCameraControllerForViewModel, TestPermissionHandler

### Community 2 - "Photobooth UI Overlays"
Cohesion: 0.05
Nodes (17): BorderOverlay(), CountdownOverlay(), ErrorOverlay(), GestureInstructionOverlay(), HandDetectionOverlay(), HomeButton(), PhotoboothLayout(), SonyMark2Screen() (+9 more)

### Community 3 - "Sony Mark2 Capture State Machine"
Cohesion: 0.1
Nodes (12): AutoReconnectState, Capturing, Complete, Countdown, Downloading, Error, Flash, GaveUp (+4 more)

### Community 4 - "Camera Domain Interface"
Cohesion: 0.07
Nodes (10): CapturedPhoto, Connected, Connecting, ConnectionState, Disconnected, Error, PhotoboothCamera, PhotoMetadata (+2 more)

### Community 5 - "Android Platform Factories"
Cohesion: 0.07
Nodes (13): initDataStore(), initWiFiConnectionManagerContext(), GestureDetector, GestureResult, HandBoundingBox, createGestureDetector(), initGestureDetectorContext(), MediaPipeGestureDetector (+5 more)

### Community 6 - "App Shell & Settings UI"
Cohesion: 0.08
Nodes (16): SettingsRepository, AutoRetryReconnectionDialog(), ReconnectionDialog(), App(), Screen, UnderConstructionScreen(), CircularCountdownTimer(), PhotoItem() (+8 more)

### Community 7 - "Sony API Discovery"
Cohesion: 0.11
Nodes (10): ApiCategory, ApiMethodInfo, ApiTestResult, CaptureMethodResult, DiscoveryResults, EventStructureAnalysis, SdCardCapabilities, SonyApiDiscoveryScreen() (+2 more)

### Community 8 - "Camera Repository"
Cohesion: 0.12
Nodes (3): CameraRepository, SonyCameraConfig, SonyA7IIICamera

### Community 10 - "Mock Camera Test Doubles"
Cohesion: 0.16
Nodes (4): MockCameraConfig, MockImageStyle, MockCameraController, MockCameraControllerTest

### Community 13 - "Camera System Documentation"
Cohesion: 0.18
Nodes (13): actTakePicture API Method, startContShooting / stopContShooting, ImageBitmapEncoder (expect/actual), LiveViewStreamParser, PhotoboothCamera Interface, SonyA7IIICamera, SonyCameraApiClient, SonyCameraApi Logging System (+5 more)

### Community 16 - "State Management Patterns"
Cohesion: 0.2
Nodes (12): Sealed Classes for State Modeling, Recreate ViewModel on Config Change, Atomic StateFlow update {} Pattern, CaptureState Sealed Class, Constructor Dependency Injection, Private MutableStateFlow + Public StateFlow, PhotoboothUiState, PhotoboothViewModel (+4 more)

### Community 18 - "Camera Network Monitor"
Cohesion: 0.29
Nodes (3): CameraNetworkMonitor, onAvailable(), onCapabilitiesChanged()

### Community 23 - "Android CameraX Rationale"
Cohesion: 0.2
Nodes (10): Suspend Functions for Async Operations, Android CameraX Implementation, Front Camera Default Decision, Camera Lifecycle Owner Binding, ImageCapture MINIMIZE_LATENCY Mode, suspendCancellableCoroutine Capture Fix, YUV to JPEG Conversion, AndroidView Compose Interop for PreviewView (+2 more)

### Community 24 - "Build & Entry Points"
Cohesion: 0.22
Nodes (9): composeApp.js Loader Script, Web App index.html Entrypoint, composeApp Module, Android assembleDebug Gradle Task, JS Browser Development Run, Desktop JVM Run Gradle Task, WasmJS Browser Development Run, iosApp Entry Point (+1 more)

### Community 31 - "Cluster 31"
Cohesion: 0.25
Nodes (7): Capturing, Complete, Countdown, Error, Flash, Idle, SonyCaptureState

### Community 33 - "Cluster 33"
Cohesion: 0.25
Nodes (7): ConnectionHealthState, Degraded, Disconnected, Failed, Healthy, NetworkStatus, Reconnecting

### Community 37 - "Cluster 37"
Cohesion: 0.25
Nodes (8): CameraController Interface, expect/actual Pattern for Platform APIs, FullscreenEffect Composable, SonyMark2Screen, WiFiConnectionManager (expect/actual), AndroidCameraPermissionHandler, Production Kiosk/Fullscreen Mode, Simple Test Doubles over Mocking Frameworks

### Community 38 - "Cluster 38"
Cohesion: 0.25
Nodes (8): Compose Multiplatform UI Decision, Layered Architecture, Unidirectional Data Flow, ViewModel + StateFlow State Management, Native Device Camera Mode, Platform Support Status Matrix, Test Pyramid Strategy, Photobooth Technical Wiki

### Community 39 - "Cluster 39"
Cohesion: 0.29
Nodes (4): ComposeView, ContentView, UIViewControllerRepresentable, View

### Community 45 - "Cluster 45"
Cohesion: 0.29
Nodes (6): CaptureState, Capturing, Complete, Countdown, Error, Idle

### Community 51 - "Cluster 51"
Cohesion: 0.29
Nodes (7): CameraRepository, DataStore over SharedPreferences Decision, PhotoboothConfig, Real-time Save Decision, SettingsRepository, SettingsScreen, Shared DataStore Instance Decision

### Community 63 - "Cluster 63"
Cohesion: 0.33
Nodes (6): CameraNetworkMonitor, SonyMark2ViewModel, Exponential Backoff Reconnection, Privacy: No Photo Persistence, Session Statistics & Periodic Logging, WiFi Status Indicator (Green/Yellow/Red)

### Community 64 - "Cluster 64"
Cohesion: 0.4
Nodes (4): Active, Frozen, LiveViewState, SonyPhotoboothUiState

### Community 72 - "Cluster 72"
Cohesion: 0.5
Nodes (4): Alpha Fairy Sony Protocol Reference, pysony Python Reference, ROCC Framework (Swift), Sony Camera Remote API

### Community 84 - "Cluster 84"
Cohesion: 0.67
Nodes (3): CircularCountdownTimer Composable, PhotoStripViewModel, Persistent Photobooth Session

## Knowledge Gaps
- **97 isolated node(s):** `Screen`, `Platform`, `PhotoStripUiState`, `CaptureState`, `Idle` (+92 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **65 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App()` connect `App Shell & Settings UI` to `Camera Repository`, `Photobooth UI Overlays`, `Sony API Discovery`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `PhotoData` connect `PhotoData Model` to `Photobooth Config & Native ViewModel`, `Photobooth UI Overlays`, `Sony Mark2 Capture State Machine`, `Mock Camera Test Doubles`, `Cluster 43`, `Cluster 44`, `Cluster 42`, `CameraController Tests`, `Cluster 29`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Why does `SonyApiDiscoveryScreen()` connect `Sony API Discovery` to `Sony Camera JSON-RPC Client`, `App Shell & Settings UI`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Are the 17 inferred relationships involving `PhotoData` (e.g. with `.startCaptureSequence()` and `.captureAndDownloadPhoto()`) actually correct?**
  _`PhotoData` has 17 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `PhotoboothViewModel` (e.g. with `.initialStateHasNotDeterminedPermission()` and `.initialCaptureStateIsIdle()`) actually correct?**
  _`PhotoboothViewModel` has 10 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Screen`, `Platform`, `PhotoStripUiState` to the rest of the system?**
  _97 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Sony Camera JSON-RPC Client` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._