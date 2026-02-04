package com.jc.photobooth.network

/**
 * Represents the health state of the camera WiFi connection.
 */
sealed class ConnectionHealthState {
    /**
     * Connection is healthy with acceptable latency.
     */
    data object Healthy : ConnectionHealthState()

    /**
     * Connection is degraded with high latency.
     *
     * @property latencyMs Current latency in milliseconds
     */
    data class Degraded(val latencyMs: Long) : ConnectionHealthState()

    /**
     * Connection is lost - camera not reachable.
     */
    data object Disconnected : ConnectionHealthState()

    /**
     * Attempting to reconnect after disconnection.
     *
     * @property attemptNumber Current reconnection attempt number
     */
    data class Reconnecting(val attemptNumber: Int) : ConnectionHealthState()

    /**
     * Reconnection failed after all attempts.
     *
     * @property reason Failure reason message
     */
    data class Failed(val reason: String) : ConnectionHealthState()
}

/**
 * Complete network status information.
 *
 * @property isConnectedToWifi Whether device is connected to WiFi
 * @property ssid WiFi network SSID (null if not connected)
 * @property isCameraReachable Whether camera API is responding
 * @property lastPingLatencyMs Last successful ping latency in ms (null if never pinged)
 * @property healthState Current connection health state
 */
data class NetworkStatus(
    val isConnectedToWifi: Boolean = false,
    val ssid: String? = null,
    val isCameraReachable: Boolean = false,
    val lastPingLatencyMs: Long? = null,
    val healthState: ConnectionHealthState = ConnectionHealthState.Disconnected
)
