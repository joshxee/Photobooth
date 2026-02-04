package com.jc.photobooth.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import com.jc.photobooth.camera.data.sony.SonyCameraApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Monitors camera network connection health on Android.
 *
 * Features:
 * - Registers NetworkCallback for WiFi state changes
 * - Performs periodic health checks (pings camera API)
 * - Detects when device switches to mobile data or other WiFi
 * - Triggers automatic reconnection on network loss
 * - Exposes connection status as StateFlow
 *
 * @param context Android application context
 * @param onHealthCheck Callback to perform camera health check, returns latency in ms or failure
 * @param onNetworkLost Callback invoked when network connection is lost
 */
class CameraNetworkMonitor(
    private val context: Context,
    private val onHealthCheck: suspend () -> Result<Long>,
    private val onNetworkLost: () -> Unit = {}
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _networkStatus = MutableStateFlow(
        NetworkStatus(
            isConnectedToWifi = false,
            ssid = null,
            isCameraReachable = false,
            lastPingLatencyMs = null,
            healthState = ConnectionHealthState.Healthy // Start optimistic, will update on first check
        )
    )
    val networkStatus: StateFlow<NetworkStatus> = _networkStatus.asStateFlow()

    private var monitorJob: Job? = null
    private var currentNetwork: Network? = null

    companion object {
        private const val HEALTH_CHECK_INTERVAL_MS = 20_000L // 20 seconds
        private const val HEALTHY_LATENCY_THRESHOLD_MS = 500L // < 500ms = healthy
        private const val INITIAL_HEALTH_CHECK_DELAY_MS = 3_000L // 3 seconds initial delay
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            updateWifiStatus(network)
        }

        override fun onLost(network: Network) {
            if (network == currentNetwork) {
                _networkStatus.update {
                    it.copy(
                        isConnectedToWifi = false,
                        ssid = null,
                        isCameraReachable = false,
                        healthState = ConnectionHealthState.Disconnected
                    )
                }
                currentNetwork = null
            }
        }

        override fun onCapabilitiesChanged(
            network: Network,
            networkCapabilities: NetworkCapabilities
        ) {
            updateWifiStatus(network)
        }
    }

    /**
     * Start monitoring network health.
     */
    fun startMonitoring() {
        // Register network callback for WiFi
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()

        connectivityManager.registerNetworkCallback(request, networkCallback)

        // Start periodic health checks
        startPeriodicHealthCheck()

        // Initial status check
        updateCurrentWifiStatus()
    }

    /**
     * Stop monitoring and cleanup resources.
     */
    fun stopMonitoring() {
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback)
        } catch (e: Exception) {
            // Ignore if not registered
        }
        monitorJob?.cancel()
        scope.cancel()
    }

    private fun startPeriodicHealthCheck() {
        monitorJob?.cancel()
        monitorJob = scope.launch {
            // Initial delay to allow camera connection to stabilize
            delay(INITIAL_HEALTH_CHECK_DELAY_MS)

            while (isActive) {
                checkCameraReachability()
                delay(HEALTH_CHECK_INTERVAL_MS)
            }
        }
    }

    private suspend fun checkCameraReachability() {
        if (!_networkStatus.value.isConnectedToWifi) {
            // No WiFi - skip health check
            return
        }

        val result = onHealthCheck()
        val latency = result.getOrNull()

        _networkStatus.update { current ->
            if (result.isSuccess && latency != null) {
                current.copy(
                    isCameraReachable = true,
                    lastPingLatencyMs = latency,
                    healthState = if (latency < HEALTHY_LATENCY_THRESHOLD_MS) {
                        ConnectionHealthState.Healthy
                    } else {
                        ConnectionHealthState.Degraded(latency)
                    }
                )
            } else {
                // Camera unreachable - trigger network lost callback
                onNetworkLost()
                current.copy(
                    isCameraReachable = false,
                    healthState = ConnectionHealthState.Disconnected
                )
            }
        }
    }

    private fun updateWifiStatus(network: Network) {
        currentNetwork = network

        val capabilities = connectivityManager.getNetworkCapabilities(network)
        val isWifi = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true

        if (isWifi) {
            // Try to get SSID (requires location permission)
            val ssid = try {
                @Suppress("DEPRECATION")
                val wifiInfo = connectivityManager.getNetworkInfo(network)
                wifiInfo?.extraInfo?.trim('"')
            } catch (e: Exception) {
                null
            }

            _networkStatus.update {
                it.copy(
                    isConnectedToWifi = true,
                    ssid = ssid
                )
            }
        }
    }

    private fun updateCurrentWifiStatus() {
        val activeNetwork = connectivityManager.activeNetwork
        if (activeNetwork != null) {
            updateWifiStatus(activeNetwork)
        }
    }
}
