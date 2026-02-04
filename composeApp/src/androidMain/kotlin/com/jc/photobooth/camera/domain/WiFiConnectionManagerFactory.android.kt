package com.jc.photobooth.camera.domain

import android.content.Context

/**
 * Android application context for WiFiConnectionManager.
 */
private var appContext: Context? = null

/**
 * Initialize WiFiConnectionManager context.
 * Must be called from MainActivity.onCreate().
 */
fun initWiFiConnectionManagerContext(context: Context) {
    appContext = context.applicationContext
}

/**
 * Creates Android WiFiConnectionManager instance.
 */
actual fun createWiFiConnectionManager(): WiFiConnectionManager? {
    val context = appContext ?: return null
    return WiFiConnectionManager(context)
}

/**
 * Opens Android WiFi settings.
 */
actual fun openWiFiSettings() {
    appContext?.let { context ->
        WiFiConnectionManager(context).openWiFiSettings()
    }
}
