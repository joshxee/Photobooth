package com.jc.photobooth.ui.overlay

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jc.photobooth.network.ConnectionHealthState
import kotlinx.coroutines.delay

/**
 * Dialog displayed when camera WiFi connection is lost.
 *
 * Features:
 * - Automatic reconnection attempts with progress
 * - Manual "Open WiFi Settings" button
 * - "Continue Anyway" option to proceed with last frame
 *
 * @param isVisible Whether the dialog should be shown
 * @param connectionState Current connection health state
 * @param onOpenWifiSettings Callback to open system WiFi settings
 * @param onContinueAnyway Callback to dismiss and continue with last frame
 * @param onRetry Callback to manually trigger reconnection
 */
@Composable
fun ReconnectionDialog(
    isVisible: Boolean,
    connectionState: ConnectionHealthState,
    onOpenWifiSettings: () -> Unit,
    onContinueAnyway: () -> Unit,
    onRetry: () -> Unit
) {
    if (isVisible) {
        AlertDialog(
            onDismissRequest = { /* Prevent dismissal by tapping outside */ },
            icon = {
                Icon(
                    imageVector = Icons.Default.Wifi,
                    contentDescription = "WiFi",
                    modifier = Modifier.size(48.dp),
                    tint = MaterialTheme.colorScheme.error
                )
            },
            title = {
                Text(
                    text = "Camera Connection Lost",
                    textAlign = TextAlign.Center
                )
            },
            text = {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Status message
                    val statusText = when (connectionState) {
                        is ConnectionHealthState.Reconnecting -> {
                            "Reconnecting to camera...\nAttempt ${connectionState.attemptNumber}"
                        }
                        is ConnectionHealthState.Failed -> {
                            "Reconnection failed.\n${connectionState.reason}"
                        }
                        else -> {
                            "The camera WiFi connection was lost.\nPlease check your WiFi settings."
                        }
                    }

                    Text(
                        text = statusText,
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.bodyMedium
                    )

                    // Progress indicator for reconnecting
                    if (connectionState is ConnectionHealthState.Reconnecting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(40.dp)
                        )
                    }

                    HorizontalDivider()

                    // Instructions
                    Text(
                        text = "Make sure you're connected to the camera's WiFi network.\n\nNetwork name: DIRECT-wbE1:XXXX-7M3",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                        textAlign = TextAlign.Center
                    )
                }
            },
            confirmButton = {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    // Retry button (if not currently reconnecting)
                    if (connectionState !is ConnectionHealthState.Reconnecting) {
                        Button(
                            onClick = onRetry,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Retry Connection")
                        }
                    }

                    // Open WiFi Settings button
                    OutlinedButton(
                        onClick = onOpenWifiSettings,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Open WiFi Settings")
                    }

                    // Continue Anyway button
                    TextButton(
                        onClick = onContinueAnyway,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Continue Anyway")
                    }
                }
            }
        )
    }
}

/**
 * Auto-retry reconnection dialog with exponential backoff.
 * Automatically attempts reconnection and updates state.
 *
 * @param isVisible Whether dialog is shown
 * @param maxAttempts Maximum reconnection attempts
 * @param onReconnect Callback to attempt reconnection, returns success
 * @param onOpenWifiSettings Callback to open WiFi settings
 * @param onDismiss Callback when user dismisses dialog
 */
@Composable
fun AutoRetryReconnectionDialog(
    isVisible: Boolean,
    maxAttempts: Int = 5,
    onReconnect: suspend () -> Boolean,
    onOpenWifiSettings: () -> Unit,
    onDismiss: () -> Unit
) {
    var attemptNumber by remember { mutableIntStateOf(0) }
    var connectionState by remember { mutableStateOf<ConnectionHealthState>(ConnectionHealthState.Disconnected) }

    // Auto-retry logic
    LaunchedEffect(isVisible) {
        if (isVisible && attemptNumber < maxAttempts) {
            while (attemptNumber < maxAttempts) {
                attemptNumber++
                connectionState = ConnectionHealthState.Reconnecting(attemptNumber)

                val success = onReconnect()
                if (success) {
                    connectionState = ConnectionHealthState.Healthy
                    onDismiss()
                    return@LaunchedEffect
                }

                // Exponential backoff: 2s, 4s, 8s, etc.
                val delayMs = (2000L * (1 shl (attemptNumber - 1))).coerceAtMost(10000L)
                delay(delayMs)
            }

            // All attempts failed
            connectionState = ConnectionHealthState.Failed("Max attempts exceeded")
        }
    }

    // Reset attempt counter when dialog closes
    LaunchedEffect(isVisible) {
        if (!isVisible) {
            attemptNumber = 0
            connectionState = ConnectionHealthState.Disconnected
        }
    }

    ReconnectionDialog(
        isVisible = isVisible,
        connectionState = connectionState,
        onOpenWifiSettings = onOpenWifiSettings,
        onContinueAnyway = onDismiss,
        onRetry = {
            attemptNumber = 0
            connectionState = ConnectionHealthState.Disconnected
        }
    )
}
