package com.jc.photobooth.network

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Desktop/JVM stub implementation of NetworkMonitor.
 * Always reports healthy connection.
 */
internal class JvmNetworkMonitor : NetworkMonitor {
    override val networkStatus: StateFlow<NetworkStatus> = MutableStateFlow(
        NetworkStatus(
            isConnectedToWifi = true,
            ssid = null,
            isCameraReachable = true,
            lastPingLatencyMs = null,
            healthState = ConnectionHealthState.Healthy
        )
    )

    override fun startMonitoring() {
        // No-op on desktop
    }

    override fun stopMonitoring() {
        // No-op on desktop
    }
}

/**
 * Creates JVM-specific NetworkMonitor stub.
 */
actual fun createNetworkMonitor(
    cameraIpAddress: String,
    onHealthCheck: suspend () -> Result<Long>,
    onNetworkLost: () -> Unit
): NetworkMonitor {
    return JvmNetworkMonitor()
}
