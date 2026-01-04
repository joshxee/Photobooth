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
import com.jc.photobooth.camera.domain.CameraRepository
import com.jc.photobooth.camera.domain.CameraType
import com.jc.photobooth.camera.ui.CameraPreviewScreen
import com.jc.photobooth.camera.ui.CameraSelectionScreen
import com.jc.photobooth.data.createDataStore
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.ui.photostrip.PhotoStripScreen
import com.jc.photobooth.ui.settings.SettingsScreen
import com.jc.photobooth.ui.BluetoothTestScreenWrapper
import org.jetbrains.compose.ui.tooling.preview.Preview

enum class Screen {
    WELCOME,
    CAMERA_SELECTION,
    PHOTOBOOTH_NATIVE,      // Native device camera (existing implementation)
    PHOTOBOOTH_SONY,        // Sony A7 III camera
    PHOTO_STRIP,
    SETTINGS,
    BLUETOOTH_TEST,         // Bluetooth camera test POC
    UNDER_CONSTRUCTION
}

@Composable
@Preview
fun App() {
    MaterialTheme {
        var currentScreen by remember { mutableStateOf(Screen.WELCOME) }
        var capturedPhotos by remember { mutableStateOf<List<PhotoData>>(emptyList()) }
        val dataStore = remember { createDataStore() }
        val cameraRepository = remember { CameraRepository(dataStore) }
        val settingsRepository = remember { SettingsRepository(dataStore) }

        when (currentScreen) {
            Screen.WELCOME -> WelcomeScreen(
                onEnterBooth = { currentScreen = Screen.CAMERA_SELECTION },
                onOpenSettings = { currentScreen = Screen.SETTINGS },
                onOpenBluetoothTest = { currentScreen = Screen.BLUETOOTH_TEST }
            )

            Screen.CAMERA_SELECTION -> CameraSelectionScreen(
                repository = cameraRepository,
                onCameraSelected = { cameraType ->
                    currentScreen = when (cameraType) {
                        CameraType.DEVICE_CAMERA -> Screen.PHOTOBOOTH_NATIVE
                        CameraType.SONY_A7III -> Screen.PHOTOBOOTH_SONY
                    }
                },
                onBack = { currentScreen = Screen.WELCOME },
                onOpenSettings = { currentScreen = Screen.SETTINGS }
            )

            Screen.PHOTOBOOTH_NATIVE -> {
                // Native camera using existing implementation
                PhotoboothScreenWrapper(
                    settingsRepository = settingsRepository,
                    onNavigateToPhotoStrip = { photos ->
                        capturedPhotos = photos
                        currentScreen = Screen.PHOTO_STRIP
                    },
                    onNavigateHome = { currentScreen = Screen.WELCOME },
                    onOpenSettings = { currentScreen = Screen.SETTINGS }
                )
            }

            Screen.PHOTOBOOTH_SONY -> {
                // Sony A7 III camera
                CameraPreviewScreen(
                    repository = cameraRepository,
                    onBack = { currentScreen = Screen.CAMERA_SELECTION }
                )
            }

            Screen.PHOTO_STRIP -> PhotoStripScreen(
                photos = capturedPhotos,
                onReturnToPhotobooth = { currentScreen = Screen.CAMERA_SELECTION }
            )

            Screen.SETTINGS -> SettingsScreen(
                repository = settingsRepository,
                onBack = { currentScreen = Screen.WELCOME }
            )

            Screen.BLUETOOTH_TEST -> BluetoothTestScreenWrapper(
                onBack = { currentScreen = Screen.WELCOME }
            )

            Screen.UNDER_CONSTRUCTION -> UnderConstructionScreen(
                onReturnHome = { currentScreen = Screen.WELCOME }
            )
        }
    }
}

@Composable
fun WelcomeScreen(
    onEnterBooth: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenBluetoothTest: () -> Unit = {}
) {
    Box(modifier = Modifier.fillMaxSize()) {
        // Settings icon in top right
        IconButton(
            onClick = onOpenSettings,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(16.dp)
        ) {
            Icon(
                imageVector = Icons.Filled.Settings,
                contentDescription = "Settings",
                tint = MaterialTheme.colorScheme.onBackground
            )
        }

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
                text = "📷",
                fontSize = 72.sp,
                textAlign = TextAlign.Center
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Welcome to Photo Booth",
                style = MaterialTheme.typography.headlineMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onBackground
            )
        }

            Column(
                modifier = Modifier.fillMaxWidth()
            ) {
                Button(
                    onClick = onEnterBooth,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = "Enter the Booth",
                        style = MaterialTheme.typography.titleMedium
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                Button(
                    onClick = onOpenBluetoothTest,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = "Test Bluetooth Camera",
                        style = MaterialTheme.typography.titleMedium
                    )
                }
            }

            Spacer(modifier = Modifier.height(32.dp))
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
                text = "🚧",
                fontSize = 72.sp,
                textAlign = TextAlign.Center
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Under Construction",
                style = MaterialTheme.typography.headlineMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onBackground
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
