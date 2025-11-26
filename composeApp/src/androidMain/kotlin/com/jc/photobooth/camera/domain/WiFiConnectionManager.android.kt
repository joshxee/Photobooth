package com.jc.photobooth.camera.domain

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.provider.Settings
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Android implementation of WiFi connection management.
 * Supports programmatic WiFi connection on Android 10+ (API 29+).
 */
actual class WiFiConnectionManager(private val context: Context) {
    private val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    private var cameraNetwork: Network? = null

    actual suspend fun isConnectedToCameraNetwork(): Boolean {
        val currentSSID = getCurrentWifiSSID()
        // Sony cameras typically use SSID starting with "DIRECT-" or "ILCE-" (camera model)
        return currentSSID?.contains("DIRECT-", ignoreCase = true) == true ||
                currentSSID?.contains("ILCE-", ignoreCase = true) == true ||
                currentSSID?.contains("Sony", ignoreCase = true) == true
    }

    actual suspend fun connectToCameraNetwork(ssid: String, password: String): Result<Unit> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Android 10+ - Use NetworkRequest API
            connectUsingNetworkRequest(ssid, password)
        } else {
            // Older Android - Direct user to WiFi settings
            openWiFiSettings()
            Result.failure(Exception("Please connect to camera WiFi manually in Settings"))
        }
    }

    actual fun openWiFiSettings() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Intent(Settings.Panel.ACTION_WIFI)
        } else {
            Intent(Settings.ACTION_WIFI_SETTINGS)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    actual suspend fun getCurrentWifiSSID(): String? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+ - Use NetworkCapabilities
                val network = connectivityManager.activeNetwork ?: return null
                val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return null
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    val wifiInfo = capabilities.transportInfo as? android.net.wifi.WifiInfo
                    wifiInfo?.ssid?.removeSurrounding("\"")
                } else null
            } else {
                @Suppress("DEPRECATION")
                val wifiInfo = wifiManager.connectionInfo
                wifiInfo?.ssid?.removeSurrounding("\"")
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Connect to WiFi using NetworkRequest (Android 10+)
     */
    @androidx.annotation.RequiresApi(Build.VERSION_CODES.Q)
    private suspend fun connectUsingNetworkRequest(ssid: String, password: String): Result<Unit> {
        return suspendCancellableCoroutine { continuation ->
            try {
                val specifier = WifiNetworkSpecifier.Builder()
                    .setSsid(ssid)
                    .setWpa2Passphrase(password)
                    .build()

                val request = NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .setNetworkSpecifier(specifier)
                    .build()

                val callback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        cameraNetwork = network

                        // Bind process to this network so HTTP requests go through it
                        connectivityManager.bindProcessToNetwork(network)

                        if (continuation.isActive) {
                            continuation.resume(Result.success(Unit))
                        }
                    }

                    override fun onUnavailable() {
                        if (continuation.isActive) {
                            continuation.resume(
                                Result.failure(Exception("Failed to connect to camera WiFi"))
                            )
                        }
                    }

                    override fun onLost(network: Network) {
                        if (cameraNetwork == network) {
                            cameraNetwork = null
                            // Unbind from network
                            connectivityManager.bindProcessToNetwork(null)
                        }
                    }
                }

                connectivityManager.requestNetwork(request, callback)

                continuation.invokeOnCancellation {
                    connectivityManager.unregisterNetworkCallback(callback)
                }
            } catch (e: Exception) {
                if (continuation.isActive) {
                    continuation.resume(Result.failure(e))
                }
            }
        }
    }

    /**
     * Disconnect from camera network
     */
    fun disconnect() {
        cameraNetwork?.let {
            connectivityManager.bindProcessToNetwork(null)
            cameraNetwork = null
        }
    }
}
