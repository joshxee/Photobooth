package com.jc.photobooth.ui.overlay

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.jc.photobooth.network.ConnectionHealthState
import com.jc.photobooth.network.NetworkStatus

/**
 * Small overlay showing WiFi connection status.
 *
 * Shows a colored WiFi icon:
 * - Green: Healthy connection
 * - Yellow: Degraded connection (high latency)
 * - Red: Disconnected
 *
 * Tap to expand details.
 *
 * @param networkStatus Current network status
 * @param modifier Modifier for positioning (typically Alignment.TopEnd)
 */
@Composable
fun ConnectionStatusOverlay(
    networkStatus: NetworkStatus,
    modifier: Modifier = Modifier
) {
    var isExpanded by remember { mutableStateOf(false) }

    // Determine icon color based on health state
    val iconColor = when (networkStatus.healthState) {
        is ConnectionHealthState.Healthy -> Color.Green
        is ConnectionHealthState.Degraded -> Color(0xFFFFB300) // Amber
        is ConnectionHealthState.Disconnected -> Color.Red
        is ConnectionHealthState.Reconnecting -> Color(0xFFFFB300) // Amber
        is ConnectionHealthState.Failed -> Color.Red
    }

    Box(
        modifier = modifier.padding(16.dp)
    ) {
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Compact WiFi icon
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.6f))
                    .clickable { isExpanded = !isExpanded },
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = if (networkStatus.isConnectedToWifi) Icons.Default.Wifi else Icons.Default.Warning,
                    contentDescription = "Connection Status",
                    tint = iconColor,
                    modifier = Modifier.size(24.dp)
                )
            }

            // Expanded details
            AnimatedVisibility(
                visible = isExpanded,
                enter = expandVertically() + fadeIn(),
                exit = shrinkVertically() + fadeOut()
            ) {
                Card(
                    modifier = Modifier.width(220.dp),
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = Color.Black.copy(alpha = 0.8f)
                    )
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        // Title
                        Text(
                            text = "Connection Status",
                            style = MaterialTheme.typography.titleSmall,
                            color = Color.White
                        )

                        HorizontalDivider(color = Color.White.copy(alpha = 0.3f))

                        // WiFi Status
                        StatusRow(
                            label = "WiFi",
                            value = if (networkStatus.isConnectedToWifi) "Connected" else "Disconnected",
                            valueColor = if (networkStatus.isConnectedToWifi) Color.Green else Color.Red
                        )

                        // SSID
                        if (networkStatus.ssid != null) {
                            StatusRow(
                                label = "Network",
                                value = networkStatus.ssid,
                                valueColor = Color.White
                            )
                        }

                        // Camera Reachability
                        StatusRow(
                            label = "Camera",
                            value = if (networkStatus.isCameraReachable) "Reachable" else "Unreachable",
                            valueColor = if (networkStatus.isCameraReachable) Color.Green else Color.Red
                        )

                        // Latency
                        if (networkStatus.lastPingLatencyMs != null) {
                            StatusRow(
                                label = "Latency",
                                value = "${networkStatus.lastPingLatencyMs}ms",
                                valueColor = when {
                                    networkStatus.lastPingLatencyMs < 500 -> Color.Green
                                    networkStatus.lastPingLatencyMs < 1000 -> Color(0xFFFFB300)
                                    else -> Color.Red
                                }
                            )
                        }

                        // Health State
                        val healthText = when (val state = networkStatus.healthState) {
                            is ConnectionHealthState.Healthy -> "Healthy"
                            is ConnectionHealthState.Degraded -> "Degraded (${state.latencyMs}ms)"
                            is ConnectionHealthState.Disconnected -> "Disconnected"
                            is ConnectionHealthState.Reconnecting -> "Reconnecting (${state.attemptNumber})"
                            is ConnectionHealthState.Failed -> "Failed: ${state.reason}"
                        }
                        StatusRow(
                            label = "Status",
                            value = healthText,
                            valueColor = iconColor
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusRow(
    label: String,
    value: String,
    valueColor: Color
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = Color.White.copy(alpha = 0.7f)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = valueColor
        )
    }
}
