package com.jc.photobooth.ui.photobooth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jc.photobooth.camera.CameraController
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.permissions.PermissionState

@Composable
fun PhotoboothScreen(
    viewModel: PhotoboothViewModel,
    cameraController: CameraController,
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit,
    onRequestPermission: () -> Unit
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
                CameraPreviewContent(
                    cameraController = cameraController,
                    captureState = uiState.captureState,
                    onCaptureClick = { viewModel.startCaptureSequence() },
                    onHomeClick = onNavigateHome
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

@Composable
private fun CameraPreviewContent(
    cameraController: CameraController,
    captureState: CaptureState,
    onCaptureClick: () -> Unit,
    onHomeClick: () -> Unit
) {
    Box(modifier = Modifier.fillMaxSize()) {
        // Camera preview
        CameraPreview(
            controller = cameraController,
            modifier = Modifier.fillMaxSize()
        )

        // Countdown overlay
        if (captureState is CaptureState.Countdown) {
            CountdownOverlay(
                remainingSeconds = captureState.remainingSeconds,
                photoIndex = captureState.photoIndex,
                totalPhotos = captureState.totalPhotos
            )
        }

        // Home button
        IconButton(
            onClick = onHomeClick,
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(16.dp)
        ) {
            Text("🏠", fontSize = 32.sp)
        }

        // Capture button
        if (captureState is CaptureState.Idle) {
            Button(
                onClick = onCaptureClick,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(32.dp)
                    .size(80.dp)
            ) {
                Text("📷", fontSize = 40.sp)
            }
        }

        // Error display
        if (captureState is CaptureState.Error) {
            Text(
                text = captureState.message,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(16.dp)
                    .background(MaterialTheme.colorScheme.error)
                    .padding(16.dp),
                color = MaterialTheme.colorScheme.onError
            )
        }
    }
}

@Composable
private fun CountdownOverlay(
    remainingSeconds: Int,
    photoIndex: Int,
    totalPhotos: Int
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.7f)),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "$remainingSeconds",
                style = MaterialTheme.typography.displayLarge,
                fontSize = 120.sp,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Photo $photoIndex of $totalPhotos",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}
