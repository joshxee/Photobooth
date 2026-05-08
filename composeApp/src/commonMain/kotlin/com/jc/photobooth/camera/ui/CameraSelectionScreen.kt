package com.jc.photobooth.camera.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.domain.CameraRepository
import com.jc.photobooth.camera.domain.CameraType
import com.jc.photobooth.camera.domain.SonyCameraConfig
import com.jc.photobooth.camera.domain.createWiFiConnectionManager
import com.jc.photobooth.camera.domain.openWiFiSettings
import com.jc.photobooth.ui.knockbox.KnockboxPill
import com.jc.photobooth.ui.knockbox.KnockboxPillStyle
import com.jc.photobooth.ui.overlay.AutoRetryReconnectionDialog
import kotlinx.coroutines.launch

@Composable
fun CameraSelectionScreen(
    repository: CameraRepository,
    onCameraSelected: (CameraType) -> Unit,
    onBack: (() -> Unit)? = null,
    onOpenSettings: () -> Unit,
    onApiDiscovery: (() -> Unit)? = null
) {
    val scope = rememberCoroutineScope()
    var availableCameras by remember { mutableStateOf<List<CameraType>>(emptyList()) }
    var selectedCamera by remember { mutableStateOf<CameraType?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var showReconnectDialog by remember { mutableStateOf(false) }
    var cameraConfig by remember { mutableStateOf<SonyCameraConfig?>(null) }

    // WiFi manager for reconnection (lazy initialization)
    val wifiManager = remember { createWiFiConnectionManager() }

    LaunchedEffect(Unit) {
        isLoading = true
        availableCameras = repository.getAvailableCameras()
        repository.selectedCameraType.collect { cameraType ->
            selectedCamera = cameraType
            isLoading = false
        }
    }

    // Load Sony camera config when available
    LaunchedEffect(availableCameras) {
        if (availableCameras.any { it == CameraType.SONY_A7III_MARK2 }) {
            cameraConfig = repository.getSonyCameraConfig()
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

            KnockboxPill(
                label = "Continue →",
                onClick = { selectedCamera?.let { onCameraSelected(it) } },
                enabled = selectedCamera != null,
                modifier = Modifier.padding(vertical = 8.dp)
            )

            if (onBack != null) {
                KnockboxPill(
                    label = "Back",
                    onClick = onBack,
                    style = KnockboxPillStyle.Outline,
                    leadingDot = false,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
            }

            if (onApiDiscovery != null) {
                KnockboxPill(
                    label = "Sony API Discovery",
                    onClick = onApiDiscovery,
                    style = KnockboxPillStyle.Ghost,
                    leadingDot = false,
                    modifier = Modifier.padding(bottom = 16.dp)
                )
            }

            val hasSonyCameras = availableCameras.any { it == CameraType.SONY_A7III_MARK2 }

            if (hasSonyCameras) {
                KnockboxPill(
                    label = "Reconnect WiFi",
                    onClick = { showReconnectDialog = true },
                    style = KnockboxPillStyle.Ghost,
                    leadingDot = false,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
            }
        }
    }

        // Reconnection dialog for manual WiFi reconnection
        if (showReconnectDialog) {
            AutoRetryReconnectionDialog(
                isVisible = showReconnectDialog,
                maxAttempts = 5,
                onReconnect = {
                    // Attempt to connect to camera WiFi
                    val config = cameraConfig
                    if (config != null && wifiManager != null) {
                        val result = wifiManager.connectToCameraNetwork(
                            ssid = config.ssid.ifEmpty { "DIRECT-wbE1:XXXX-7M3" },
                            password = config.password
                        )
                        result.isSuccess
                    } else {
                        false
                    }
                },
                onOpenWifiSettings = {
                    openWiFiSettings()
                },
                onDismiss = {
                    showReconnectDialog = false
                }
            )
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
        shape = RectangleShape,
        elevation = CardDefaults.cardElevation(
            defaultElevation = 0.dp
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
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = "Selected",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(28.dp)
                )
            }
        }
    }
}
