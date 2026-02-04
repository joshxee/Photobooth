package com.jc.photobooth.network

import kotlinx.coroutines.flow.StateFlow

/**
 * Platform-agnostic network monitoring interface.
 *
 * Monitors WiFi connection status and camera reachability.
 * Use expect/actual pattern for platform-specific implementations.
 */
interface NetworkMonitor {
    /**
     * Current network status as a StateFlow.
     */
    val networkStatus: StateFlow<NetworkStatus>

    /**
     * Start monitoring network status.
     * Should be called when monitoring is needed (e.g., when camera screen is visible).
     */
    fun startMonitoring()

    /**
     * Stop monitoring network status.
     * Should be called when monitoring is no longer needed (e.g., when leaving camera screen).
     */
    fun stopMonitoring()
}

/**
 * Creates a platform-specific NetworkMonitor instance.
 *
 * @param cameraIpAddress IP address of the camera to monitor
 * @param onHealthCheck Callback to perform camera API health check, returns latency in ms
 * @param onNetworkLost Callback invoked when network connection is lost
 */
expect fun createNetworkMonitor(
    cameraIpAddress: String,
    onHealthCheck: suspend () -> Result<Long>,
    onNetworkLost: () -> Unit
): NetworkMonitor
