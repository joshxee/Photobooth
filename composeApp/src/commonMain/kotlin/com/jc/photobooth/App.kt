package com.jc.photobooth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jc.photobooth.camera.data.sony.SonyA7IIICamera
import com.jc.photobooth.gesture.GestureDetector
import com.jc.photobooth.gesture.createGestureDetector
import com.jc.photobooth.ui.theme.PhotoboothTheme
import com.jc.photobooth.camera.domain.CameraRepository
import com.jc.photobooth.camera.domain.CameraType
import com.jc.photobooth.camera.ui.CameraSelectionScreen
import com.jc.photobooth.camera.ui.discovery.SonyApiDiscoveryScreen
import com.jc.photobooth.data.createDataStore
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.ui.photobooth.sony.SonyPhotoboothScreen
import com.jc.photobooth.ui.photobooth.sony.mark2.SonyMark2Screen
import com.jc.photobooth.ui.photostrip.PhotoStripScreen
import com.jc.photobooth.ui.settings.SettingsScreen
import org.jetbrains.compose.ui.tooling.preview.Preview

enum class Screen {
    CAMERA_SELECTION,
    PHOTOBOOTH_NATIVE,      // Native device camera (existing implementation)
    PHOTOBOOTH_SONY,        // Sony A7 III camera (Mark 1.1 - Screenshot)
    PHOTOBOOTH_SONY_MARK2,  // Sony A7 III camera (Mark 2.0 - WiFi Transfer)
    PHOTOBOOTH_MOCK,        // Mock camera for testing (no hardware required)
    PHOTO_STRIP,
    SETTINGS,
    SONY_API_DISCOVERY,     // Sony API discovery tool
    UNDER_CONSTRUCTION
}

@Composable
@Preview
fun App() {
    PhotoboothTheme {
        var currentScreen by remember { mutableStateOf(Screen.CAMERA_SELECTION) }
        var previousCameraScreen by remember { mutableStateOf<Screen?>(null) }
        var capturedPhotos by remember { mutableStateOf<List<PhotoData>>(emptyList()) }
        val dataStore = remember { createDataStore() }
        val cameraRepository = remember { CameraRepository(dataStore) }
        val settingsRepository = remember { SettingsRepository(dataStore) }

        // Create gesture detector (Android-only, null on other platforms)
        val gestureDetector = remember<GestureDetector?> { createGestureDetector() }

        // Persist SonyMark2ViewModel across navigation for continuous sessions
        val sonyMark2ViewModel = remember {
            com.jc.photobooth.ui.photobooth.sony.mark2.SonyMark2ViewModel(
                settingsRepository = settingsRepository,
                gestureDetector = gestureDetector
            )
        }

        when (currentScreen) {
            Screen.CAMERA_SELECTION -> CameraSelectionScreen(
                repository = cameraRepository,
                onCameraSelected = { cameraType ->
                    currentScreen = when (cameraType) {
                        CameraType.DEVICE_CAMERA -> Screen.PHOTOBOOTH_NATIVE
                        CameraType.SONY_A7III -> Screen.PHOTOBOOTH_SONY
                        CameraType.SONY_A7III_MARK2 -> Screen.PHOTOBOOTH_SONY_MARK2
                        // Mock camera uses native photobooth workflow for now
                        CameraType.MOCK_CAMERA -> Screen.PHOTOBOOTH_NATIVE
                    }
                },
                onBack = null, // No back navigation from camera selection (it's the home screen)
                onOpenSettings = { currentScreen = Screen.SETTINGS },
                onApiDiscovery = { currentScreen = Screen.SONY_API_DISCOVERY }
            )

            Screen.PHOTOBOOTH_NATIVE -> {
                // Native camera using existing implementation
                PhotoboothScreenWrapper(
                    settingsRepository = settingsRepository,
                    onNavigateToPhotoStrip = { photos ->
                        capturedPhotos = photos
                        currentScreen = Screen.PHOTO_STRIP
                    },
                    onNavigateHome = { currentScreen = Screen.CAMERA_SELECTION },
                    onOpenSettings = { currentScreen = Screen.SETTINGS }
                )
            }

            Screen.PHOTOBOOTH_SONY -> {
                // Sony A7 III camera - Mark 1.1 Screenshot Workflow
                println("[APP] Navigating to PHOTOBOOTH_SONY screen")

                val sonyCamera = remember {
                    println("[APP] Getting Sony camera instance from repository...")
                    val camera = cameraRepository.getCameraInstance(CameraType.SONY_A7III) as? SonyA7IIICamera
                    println("[APP] Camera instance: $camera")
                    println("[APP] Camera connection state: ${camera?.connectionState?.value}")
                    println("[APP] Camera live view active: ${camera?.liveViewFrame?.value != null}")
                    camera
                }

                if (sonyCamera != null) {
                    println("[APP] Rendering SonyPhotoboothScreen with camera")
                    SonyPhotoboothScreen(
                        camera = sonyCamera,
                        settingsRepository = settingsRepository,
                        onNavigateToPhotoStrip = { photos ->
                            println("[APP] Navigating to photo strip with ${photos.size} photos")
                            capturedPhotos = photos
                            currentScreen = Screen.PHOTO_STRIP
                        },
                        onNavigateHome = {
                            println("[APP] Navigating home from Sony photobooth")
                            currentScreen = Screen.CAMERA_SELECTION
                        }
                    )
                } else {
                    // Fallback if camera not available
                    println("[APP] ERROR: Sony camera not available! Showing under construction screen")
                    UnderConstructionScreen(
                        onReturnHome = { currentScreen = Screen.CAMERA_SELECTION }
                    )
                }
            }

            Screen.PHOTOBOOTH_SONY_MARK2 -> {
                // Sony A7 III camera - Mark 2.0 WiFi Transfer
                println("[APP] Navigating to PHOTOBOOTH_SONY_MARK2 screen")

                // Restart live view when returning from photo strip (persistent session)
                val isReturningFromPhotoStrip = previousCameraScreen == Screen.PHOTOBOOTH_SONY_MARK2
                LaunchedEffect(currentScreen, isReturningFromPhotoStrip) {
                    if (isReturningFromPhotoStrip) {
                        println("[APP] Returning from photo strip - restarting live view")
                        sonyMark2ViewModel.restartLiveView()
                        // Reset flag so subsequent returns also trigger the restart
                        previousCameraScreen = null
                    }
                }

                SonyMark2Screen(
                    viewModel = sonyMark2ViewModel,
                    settingsRepository = settingsRepository,
                    onNavigateToPhotoStrip = { photos ->
                        println("[APP] Mark 2.0: Navigating to photo strip with ${photos.size} photos")
                        previousCameraScreen = Screen.PHOTOBOOTH_SONY_MARK2
                        capturedPhotos = photos
                        currentScreen = Screen.PHOTO_STRIP
                    },
                    onNavigateHome = {
                        println("[APP] Navigating home from Sony Mark 2.0")
                        previousCameraScreen = null
                        currentScreen = Screen.CAMERA_SELECTION
                    }
                )
            }

            Screen.PHOTOBOOTH_MOCK -> {
                // Mock camera for testing and development (no hardware required)
                // Uses the same native photobooth workflow as device camera
                PhotoboothScreenWrapper(
                    settingsRepository = settingsRepository,
                    onNavigateToPhotoStrip = { photos ->
                        capturedPhotos = photos
                        currentScreen = Screen.PHOTO_STRIP
                    },
                    onNavigateHome = { currentScreen = Screen.CAMERA_SELECTION },
                    onOpenSettings = { currentScreen = Screen.SETTINGS }
                )
            }

            Screen.PHOTO_STRIP -> {
                // Get countdown duration from settings
                val config by settingsRepository.getConfig().collectAsState(
                    initial = com.jc.photobooth.model.PhotoboothConfig()
                )

                PhotoStripScreen(
                    photos = capturedPhotos,
                    countdownDurationSeconds = 10, // Fixed 10 seconds for photo strip display
                    onReturnToLiveView = previousCameraScreen?.let { prevScreen ->
                        {
                            // Return directly to the previous camera screen (persistent session)
                            println("[APP] Returning to previous camera screen: $prevScreen")
                            currentScreen = prevScreen
                        }
                    },
                    onReturnToPhotobooth = {
                        // Fallback: return to camera selection if no previous screen
                        println("[APP] Returning to camera selection")
                        previousCameraScreen = null
                        currentScreen = Screen.CAMERA_SELECTION
                    }
                )
            }

            Screen.SETTINGS -> SettingsScreen(
                repository = settingsRepository,
                onBack = { currentScreen = Screen.CAMERA_SELECTION }
            )

            Screen.SONY_API_DISCOVERY -> SonyApiDiscoveryScreen(
                onBack = { currentScreen = Screen.CAMERA_SELECTION }
            )

            Screen.UNDER_CONSTRUCTION -> UnderConstructionScreen(
                onReturnHome = { currentScreen = Screen.CAMERA_SELECTION }
            )
        }
    }
}

@Composable
fun UnderConstructionScreen(onReturnHome: () -> Unit) {
    Column(
        modifier = Modifier
            .background(MaterialTheme.colorScheme.background)
            .fillMaxSize()
            .safeContentPadding()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        Spacer(modifier = Modifier.weight(1f))

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.weight(2f)
        ) {
            Text(
                text = "Under Construction",
                style = MaterialTheme.typography.displayMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onBackground
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "This feature is coming soon",
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.secondary
            )
        }

        Button(
            onClick = onReturnHome,
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 32.dp)
        ) {
            Text(
                text = "Return Home",
                style = MaterialTheme.typography.titleMedium
            )
        }
    }
}
