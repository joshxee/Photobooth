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
import com.jc.photobooth.gesture.GestureDetector
import com.jc.photobooth.gesture.createGestureDetector
import com.jc.photobooth.ui.theme.PhotoboothTheme
import com.jc.photobooth.camera.domain.CameraRepository
import com.jc.photobooth.camera.domain.CameraType
import com.jc.photobooth.camera.ui.CameraSelectionScreen
import com.jc.photobooth.camera.ui.discovery.SonyApiDiscoveryScreen
import com.jc.photobooth.data.createDataStore
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.ui.photobooth.NativePhotoboothScreen
import com.jc.photobooth.ui.photobooth.sony.mark2.SonyMark2Screen
import com.jc.photobooth.ui.settings.SettingsScreen
import org.jetbrains.compose.ui.tooling.preview.Preview

enum class Screen {
    CAMERA_SELECTION,
    PHOTOBOOTH_NATIVE,
    PHOTOBOOTH_SONY_MARK2,
    PHOTOBOOTH_MOCK,
    SETTINGS,
    SONY_API_DISCOVERY,
    UNDER_CONSTRUCTION
}

@Composable
@Preview
fun App() {
    PhotoboothTheme {
        var currentScreen by remember { mutableStateOf(Screen.CAMERA_SELECTION) }
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
            Screen.CAMERA_SELECTION -> Box(modifier = Modifier.fillMaxSize()) {
                CameraSelectionScreen(
                    repository = cameraRepository,
                    onCameraSelected = { cameraType ->
                        currentScreen = when (cameraType) {
                            CameraType.DEVICE_CAMERA -> Screen.PHOTOBOOTH_NATIVE
                            CameraType.SONY_A7III_MARK2 -> Screen.PHOTOBOOTH_SONY_MARK2
                            CameraType.MOCK_CAMERA -> Screen.PHOTOBOOTH_NATIVE
                        }
                    },
                    onBack = null, // No back navigation from camera selection (it's the home screen)
                    onOpenSettings = { currentScreen = Screen.SETTINGS },
                    onApiDiscovery = { currentScreen = Screen.SONY_API_DISCOVERY }
                )
            }

            Screen.PHOTOBOOTH_NATIVE -> {
                NativePhotoboothScreen(
                    settingsRepository = settingsRepository,
                    onHome = { currentScreen = Screen.CAMERA_SELECTION },
                    onOpenSettings = { currentScreen = Screen.SETTINGS }
                )
            }

            Screen.PHOTOBOOTH_SONY_MARK2 -> SonyMark2Screen(
                viewModel = sonyMark2ViewModel,
                settingsRepository = settingsRepository,
                onHome = { currentScreen = Screen.CAMERA_SELECTION }
            )

            Screen.PHOTOBOOTH_MOCK -> {
                NativePhotoboothScreen(
                    settingsRepository = settingsRepository,
                    onHome = { currentScreen = Screen.CAMERA_SELECTION },
                    onOpenSettings = { currentScreen = Screen.SETTINGS }
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
