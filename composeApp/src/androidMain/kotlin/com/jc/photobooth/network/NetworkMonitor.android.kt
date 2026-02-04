package com.jc.photobooth.network

import android.content.Context

/**
 * Android implementation of NetworkMonitor using CameraNetworkMonitor.
 */
internal class AndroidNetworkMonitor(
    private val context: Context,
    private val onHealthCheck: suspend () -> Result<Long>,
    private val onNetworkLost: () -> Unit
) : NetworkMonitor {

    private val monitor = CameraNetworkMonitor(
        context = context,
        onHealthCheck = onHealthCheck,
        onNetworkLost = onNetworkLost
    )

    override val networkStatus = monitor.networkStatus

    override fun startMonitoring() {
        monitor.startMonitoring()
    }

    override fun stopMonitoring() {
        monitor.stopMonitoring()
    }
}

/**
 * Creates Android-specific NetworkMonitor instance.
 * Requires application context for ConnectivityManager access.
 */
actual fun createNetworkMonitor(
    cameraIpAddress: String,
    onHealthCheck: suspend () -> Result<Long>,
    onNetworkLost: () -> Unit
): NetworkMonitor {
    val context = getApplicationContext()
    return AndroidNetworkMonitor(
        context = context,
        onHealthCheck = onHealthCheck,
        onNetworkLost = onNetworkLost
    )
}

/**
 * Gets the application context for Android services.
 * This function should be initialized in MainActivity.
 */
private var appContext: Context? = null

fun initNetworkMonitorContext(context: Context) {
    appContext = context.applicationContext
}

private fun getApplicationContext(): Context {
    return appContext ?: error("NetworkMonitor context not initialized. Call initNetworkMonitorContext() in MainActivity.")
}
