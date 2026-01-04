package com.jc.photobooth.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.BluetoothCameraController
import com.jc.photobooth.camera.BluetoothCameraState
import com.jc.photobooth.camera.BluetoothCameraStatus
import kotlinx.coroutines.launch

/**
 * Test screen for Bluetooth camera control POC.
 *
 * This screen allows testing the Bluetooth remote control functionality
 * with a Sony camera (e.g., A7 III).
 *
 * Usage:
 * 1. Pair your Sony camera with your Android device via Bluetooth settings
 * 2. Enable "Bluetooth Remote Control" in the camera settings
 * 3. Enter the camera's Bluetooth MAC address (found in device settings)
 * 4. Connect and test shutter control
 */
@Composable
fun BluetoothTestScreen(
    controller: BluetoothCameraController,
    onBack: () -> Unit
) {
    val cameraState by controller.cameraState.collectAsState()
    val cameraStatus by controller.cameraStatus.collectAsState()
    val scope = rememberCoroutineScope()

    // Camera MAC address input
    var address by remember { mutableStateOf("") }
    var isConnecting by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Title
        Text(
            text = "Bluetooth Camera Test",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Connection status
        ConnectionStatusCard(cameraState, cameraStatus)

        Spacer(modifier = Modifier.height(8.dp))

        // Address input and connection controls
        if (cameraState !is BluetoothCameraState.Connected) {
            OutlinedTextField(
                value = address,
                onValueChange = { address = it.uppercase() },
                label = { Text("Camera Bluetooth Address") },
                placeholder = { Text("XX:XX:XX:XX:XX:XX") },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isConnecting
            )

            Text(
                text = "Find the MAC address in your phone's Bluetooth settings after pairing",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Button(
                onClick = {
                    scope.launch {
                        isConnecting = true
                        try {
                            controller.connect(address)
                        } finally {
                            isConnecting = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = address.isNotBlank() && !isConnecting
            ) {
                Text(if (isConnecting) "Connecting..." else "Connect to Camera")
            }
        } else {
            Button(
                onClick = { controller.disconnect() },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error
                )
            ) {
                Text("Disconnect")
            }
        }

        Divider()

        // Shutter controls - only enabled when connected
        if (cameraState is BluetoothCameraState.Connected || cameraState is BluetoothCameraState.RemoteDisabled) {
            Text(
                text = "Shutter Controls",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )

            Button(
                onClick = {
                    scope.launch {
                        controller.triggerShutter(waitForFocus = false)
                    }
                },
                modifier = Modifier.fillMaxWidth().height(60.dp),
                enabled = cameraState is BluetoothCameraState.Connected
            ) {
                Text("Take Photo", style = MaterialTheme.typography.titleMedium)
            }

            Button(
                onClick = {
                    scope.launch {
                        controller.triggerShutter(waitForFocus = true)
                    }
                },
                modifier = Modifier.fillMaxWidth().height(60.dp),
                enabled = cameraState is BluetoothCameraState.Connected
            ) {
                Text("Take Photo (Wait for Focus)", style = MaterialTheme.typography.titleMedium)
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    onClick = {
                        scope.launch {
                            controller.pressShutter(halfPress = true)
                        }
                    },
                    modifier = Modifier.weight(1f),
                    enabled = cameraState is BluetoothCameraState.Connected
                ) {
                    Text("Half Press")
                }

                Button(
                    onClick = {
                        scope.launch {
                            controller.releaseShutter(halfPress = false)
                        }
                    },
                    modifier = Modifier.weight(1f),
                    enabled = cameraState is BluetoothCameraState.Connected
                ) {
                    Text("Release")
                }
            }

            Divider()

            Button(
                onClick = {
                    scope.launch {
                        controller.toggleRecording()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = cameraState is BluetoothCameraState.Connected,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.tertiary
                )
            ) {
                Text("Toggle Recording")
            }

            Button(
                onClick = {
                    scope.launch {
                        controller.triggerAutofocus()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = cameraState is BluetoothCameraState.Connected
            ) {
                Text("Trigger Autofocus (AF-ON)")
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        // Instructions
        InstructionsCard()

        // Back button
        OutlinedButton(
            onClick = onBack,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Back to Main Menu")
        }
    }
}

@Composable
private fun ConnectionStatusCard(
    cameraState: BluetoothCameraState,
    cameraStatus: BluetoothCameraStatus
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = when (cameraState) {
                is BluetoothCameraState.Connected -> MaterialTheme.colorScheme.primaryContainer
                is BluetoothCameraState.Error -> MaterialTheme.colorScheme.errorContainer
                is BluetoothCameraState.RemoteDisabled -> MaterialTheme.colorScheme.tertiaryContainer
                else -> MaterialTheme.colorScheme.surfaceVariant
            }
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Status: ${getStatusText(cameraState)}",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )

            if (cameraState is BluetoothCameraState.Connected) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Camera: ${cameraState.deviceName}",
                    style = MaterialTheme.typography.bodyMedium
                )
                Text(
                    text = "Focus: ${if (cameraStatus.focusAcquired) "✓ Acquired" else "⊗ Not acquired"}",
                    style = MaterialTheme.typography.bodySmall
                )
                Text(
                    text = "Shutter: ${if (cameraStatus.shutterReady) "✓ Ready" else "⊗ Not ready"}",
                    style = MaterialTheme.typography.bodySmall
                )
                Text(
                    text = "Recording: ${if (cameraStatus.recording) "● REC" else "○ Stopped"}",
                    style = MaterialTheme.typography.bodySmall
                )
            }

            if (cameraState is BluetoothCameraState.Error) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = cameraState.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }
    }
}

@Composable
private fun InstructionsCard() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Setup Instructions",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "1. On your camera: Menu → Network → Bluetooth → Bluetooth Function → On\n" +
                        "2. On your camera: Enable \"Ctrl w/ Smartphone\"\n" +
                        "3. On your phone: Settings → Bluetooth → Pair with camera\n" +
                        "4. Find camera's MAC address in phone's Bluetooth settings\n" +
                        "5. Enter MAC address above and connect\n" +
                        "6. Test shutter button!",
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

private fun getStatusText(state: BluetoothCameraState): String = when (state) {
    is BluetoothCameraState.Disconnected -> "Disconnected"
    is BluetoothCameraState.Connecting -> "Connecting..."
    is BluetoothCameraState.Connected -> "Connected"
    is BluetoothCameraState.RemoteDisabled -> "Connected (Remote Disabled in Camera)"
    is BluetoothCameraState.NotPaired -> "Not Paired - Pair in Bluetooth Settings"
    is BluetoothCameraState.Error -> "Error"
}
