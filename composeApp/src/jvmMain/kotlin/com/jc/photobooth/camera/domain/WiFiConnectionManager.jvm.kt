package com.jc.photobooth.camera.domain

import java.awt.Desktop
import java.net.NetworkInterface
import java.net.URI

/**
 * JVM (Desktop) implementation of WiFi connection management.
 * Limited functionality - mainly guides users to manually connect.
 */
actual class WiFiConnectionManager {
    actual suspend fun isConnectedToCameraNetwork(): Boolean {
        // Check if we can reach the camera's default IP
        return try {
            val cameraHost = "192.168.122.1"
            val address = java.net.InetAddress.getByName(cameraHost)
            address.isReachable(2000) // 2 second timeout
        } catch (e: Exception) {
            false
        }
    }

    actual suspend fun connectToCameraNetwork(ssid: String, password: String): Result<Unit> {
        // JVM cannot programmatically connect to WiFi
        // Try to open system WiFi settings
        openWiFiSettings()

        return Result.failure(
            Exception("Please connect to WiFi network '$ssid' manually.\nPassword: $password")
        )
    }

    actual fun openWiFiSettings() {
        try {
            when {
                // macOS
                System.getProperty("os.name").contains("Mac", ignoreCase = true) -> {
                    ProcessBuilder("open", "/System/Library/PreferencePanes/Network.prefPane").start()
                }
                // Windows
                System.getProperty("os.name").contains("Windows", ignoreCase = true) -> {
                    ProcessBuilder("control.exe", "/name", "Microsoft.NetworkAndSharingCenter").start()
                }
                // Linux
                else -> {
                    // Try to open network manager on Linux (varies by distro)
                    try {
                        ProcessBuilder("nm-connection-editor").start()
                    } catch (e: Exception) {
                        println("Please open your system's WiFi settings and connect to the camera network")
                    }
                }
            }
        } catch (e: Exception) {
            println("Could not open WiFi settings: ${e.message}")
        }
    }

    actual suspend fun getCurrentWifiSSID(): String? {
        return try {
            // Try to get network interface names
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val networkInterface = interfaces.nextElement()
                if (networkInterface.isUp && !networkInterface.isLoopback) {
                    // Return interface name as a proxy (actual SSID detection is platform-specific)
                    return networkInterface.displayName
                }
            }
            null
        } catch (e: Exception) {
            null
        }
    }
}
