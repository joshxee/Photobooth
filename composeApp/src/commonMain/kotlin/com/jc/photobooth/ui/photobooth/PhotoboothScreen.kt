package com.jc.photobooth.ui.photobooth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.CameraController
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.permissions.PermissionState
import com.jc.photobooth.ui.photobooth.common.PhotoboothLayout
import com.jc.photobooth.ui.photobooth.strategy.NativeContentStrategy

@Composable
fun PhotoboothScreen(
    viewModel: PhotoboothViewModel,
    cameraController: CameraController,
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit,
    onRequestPermission: () -> Unit,
    onOpenSettings: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(uiState.captureState) {
        if (uiState.captureState is CaptureState.Complete) {
            val photos = (uiState.captureState as CaptureState.Complete).photos
            onNavigateToPhotoStrip(photos)
            viewModel.resetCapture()
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when {
            !uiState.permissionState.isGranted -> {
                PermissionDeniedContent(
                    permissionState = uiState.permissionState,
                    onRequestPermission = {
                        viewModel.onPermissionRequested()
                        onRequestPermission()
                    },
                    onOpenSettings = { viewModel.openSettings() },
                    onNavigateHome = onNavigateHome
                )
            }
            else -> {
                val strategy = remember(cameraController, onOpenSettings) {
                    NativeContentStrategy(cameraController, onOpenSettings)
                }
                PhotoboothLayout(
                    contentStrategy = strategy,
                    captureState = uiState.captureState,
                    onHomeClick = onNavigateHome,
                    onCaptureClick = { viewModel.startCaptureSequence() }
                )
            }
        }
    }
}

@Composable
private fun PermissionDeniedContent(
    permissionState: PermissionState,
    onRequestPermission: () -> Unit,
    onOpenSettings: () -> Unit,
    onNavigateHome: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "Camera Access Required",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = when (permissionState) {
                PermissionState.PERMANENTLY_DENIED ->
                    "Camera permission is denied. Please enable it in settings to use the photobooth."
                else ->
                    "We need camera access to take photos in the photobooth."
            },
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onBackground
        )

        Spacer(modifier = Modifier.height(32.dp))

        if (permissionState.shouldShowRationale) {
            Button(onClick = onOpenSettings) {
                Text("Open Settings")
            }
        } else {
            Button(onClick = onRequestPermission) {
                Text("Grant Permission")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        TextButton(onClick = onNavigateHome) {
            Text("Go Back")
        }
    }
}

