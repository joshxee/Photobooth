package com.jc.photobooth.camera.domain

/**
 * Factory to create platform-specific WiFiConnectionManager instances.
 * Returns null on platforms where WiFi management is not supported.
 */
expect fun createWiFiConnectionManager(): WiFiConnectionManager?

/**
 * Opens WiFi settings on supported platforms.
 * No-op on platforms where this is not available.
 */
expect fun openWiFiSettings()
