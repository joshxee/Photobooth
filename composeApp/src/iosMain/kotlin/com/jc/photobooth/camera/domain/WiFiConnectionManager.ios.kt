package com.jc.photobooth.camera.domain

import platform.Foundation.NSURL
import platform.SystemConfiguration.CNCopyCurrentNetworkInfo
import platform.UIKit.UIApplication
import platform.UIKit.UIApplicationOpenSettingsURLString

/**
 * iOS implementation of WiFi connection management.
 * iOS does not allow programmatic WiFi connection, so this guides users to Settings.
 */
actual class WiFiConnectionManager {
    actual suspend fun isConnectedToCameraNetwork(): Boolean {
        val currentSSID = getCurrentWifiSSID()
        // Sony cameras typically use SSID starting with "DIRECT-" or "ILCE-" (camera model)
        return currentSSID?.contains("DIRECT-", ignoreCase = true) == true ||
                currentSSID?.contains("ILCE-", ignoreCase = true) == true ||
                currentSSID?.contains("Sony", ignoreCase = true) == true
    }

    actual suspend fun connectToCameraNetwork(ssid: String, password: String): Result<Unit> {
        // iOS doesn't allow programmatic WiFi connection
        // Open Settings app to guide user
        openWiFiSettings()

        return Result.failure(
            Exception("Please connect to WiFi network '$ssid' manually in Settings.\nPassword: $password")
        )
    }

    actual fun openWiFiSettings() {
        // iOS opens app-specific settings, user must navigate to WiFi
        val settingsUrl = NSURL.URLWithString(UIApplicationOpenSettingsURLString)
        if (settingsUrl != null && UIApplication.sharedApplication.canOpenURL(settingsUrl)) {
            UIApplication.sharedApplication.openURL(settingsUrl)
        }
    }

    actual suspend fun getCurrentWifiSSID(): String? {
        return try {
            // Note: This requires specific entitlements in iOS
            // Add "Access WiFi Information" capability in Xcode
            @Suppress("DEPRECATION")
            val interfaces = listOf("en0") // WiFi interface
            for (interfaceName in interfaces) {
                val info = CNCopyCurrentNetworkInfo(interfaceName)
                if (info != null) {
                    // Extract SSID from network info dictionary
                    // This is simplified - actual implementation needs proper CFDictionary handling
                    return interfaceName // Placeholder
                }
            }
            null
        } catch (e: Exception) {
            null
        }
    }
}
