package com.jc.photobooth.camera.domain

/**
 * Platform-specific WiFi connection management for camera connectivity.
 * Use expect/actual pattern to handle different platform capabilities.
 */
expect class WiFiConnectionManager {
    /**
     * Check if currently connected to the camera's WiFi network
     */
    suspend fun isConnectedToCameraNetwork(): Boolean

    /**
     * Attempt to connect to camera's WiFi network.
     * On Android 10+: Can programmatically connect
     * On iOS: Opens WiFi settings for manual connection
     *
     * @param ssid Camera WiFi network name
     * @param password Camera WiFi password
     */
    suspend fun connectToCameraNetwork(ssid: String, password: String): Result<Unit>

    /**
     * Open platform WiFi settings
     * Useful for iOS or when automatic connection fails on Android
     */
    fun openWiFiSettings()

    /**
     * Get current WiFi network SSID (if available)
     */
    suspend fun getCurrentWifiSSID(): String?
}
