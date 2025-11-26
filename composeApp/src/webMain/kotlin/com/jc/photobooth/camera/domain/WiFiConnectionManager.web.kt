package com.jc.photobooth.camera.domain

/**
 * Web (JS/WASM) implementation of WiFi connection management.
 * Very limited functionality - browsers cannot access WiFi info or control connections.
 */
actual class WiFiConnectionManager {
    actual suspend fun isConnectedToCameraNetwork(): Boolean {
        // In browser, we can only test if we can reach the camera
        return try {
            // This would require CORS to be enabled on camera
            // For now, return false and let user verify connection manually
            false
        } catch (e: Exception) {
            false
        }
    }

    actual suspend fun connectToCameraNetwork(ssid: String, password: String): Result<Unit> {
        // Browsers cannot programmatically connect to WiFi
        return Result.failure(
            Exception("Please connect to WiFi network '$ssid' manually in your system settings.\nPassword: $password")
        )
    }

    actual fun openWiFiSettings() {
        // Cannot open system WiFi settings from browser
        // Just show a message to the user
        console.log("Please connect to your camera's WiFi network manually")
    }

    actual suspend fun getCurrentWifiSSID(): String? {
        // Browsers cannot access WiFi SSID information
        return null
    }
}
