package com.jc.photobooth.camera.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.domain.CameraRepository
import com.jc.photobooth.camera.domain.CameraType
import kotlinx.coroutines.launch

@Composable
fun CameraSelectionScreen(
    repository: CameraRepository,
    onCameraSelected: (CameraType) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onApiDiscovery: (() -> Unit)? = null
) {
    val scope = rememberCoroutineScope()
    var availableCameras by remember { mutableStateOf<List<CameraType>>(emptyList()) }
    var selectedCamera by remember { mutableStateOf<CameraType?>(null) }
    var isLoading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        isLoading = true
        availableCameras = repository.getAvailableCameras()
        repository.selectedCameraType.collect { cameraType ->
            selectedCamera = cameraType
            isLoading = false
        }
    }

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
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Header
            Text(
                text = "Select Camera",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground
            )

        Spacer(modifier = Modifier.height(32.dp))

        if (isLoading) {
            CircularProgressIndicator()
        } else {
            // Camera options
            availableCameras.forEach { cameraType ->
                CameraOptionCard(
                    cameraType = cameraType,
                    isSelected = cameraType == selectedCamera,
                    onClick = {
                        scope.launch {
                            repository.setSelectedCamera(cameraType)
                            selectedCamera = cameraType
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp)
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            // Continue button
            Button(
                onClick = {
                    selectedCamera?.let { onCameraSelected(it) }
                },
                enabled = selectedCamera != null,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
            ) {
                Text(
                    text = "Continue",
                    style = MaterialTheme.typography.titleMedium
                )
            }

            // Back button
            OutlinedButton(
                onClick = onBack,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
            ) {
                Text(
                    text = "Back",
                    style = MaterialTheme.typography.titleMedium
                )
            }

            // API Discovery button (dev tool)
            if (onApiDiscovery != null) {
                TextButton(
                    onClick = onApiDiscovery,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 16.dp)
                ) {
                    Text(
                        text = "Sony API Discovery",
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
        }
    }
    }
}

@Composable
fun CameraOptionCard(
    cameraType: CameraType,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surface
            }
        ),
        shape = RoundedCornerShape(12.dp),
        elevation = CardDefaults.cardElevation(
            defaultElevation = if (isSelected) 4.dp else 2.dp
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = cameraType.displayName,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (isSelected) {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    }
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = when (cameraType) {
                        CameraType.DEVICE_CAMERA -> "Use your device's built-in camera"
                        CameraType.SONY_A7III -> "Screenshot workflow • Live view screenshots • High-res backups to SD"
                        CameraType.SONY_A7III_MARK2 -> "WiFi transfer • Downloads actual photos • Requires Single Shot mode"
                        CameraType.MOCK_CAMERA -> "Test mode • Fast capture • No hardware required"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (isSelected) {
                        MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f)
                    } else {
                        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                    }
                )
            }

            if (isSelected) {
                Text(
                    text = "✓",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.primary
                )
            }
        }
    }
}
