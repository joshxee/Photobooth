package com.jc.photobooth.camera.data.sony

import android.util.Log

/**
 * Android-specific logger that outputs to Android Logcat.
 *
 * Filter in logcat with:
 *   adb logcat -s SonyCameraApi
 *   adb logcat SonyCameraApi:D *:S
 *
 * Or in Android Studio Logcat panel, filter by tag: SonyCameraApi
 */
object AndroidLogger : SonyCameraLogger {
    override fun d(tag: String, message: String) {
        Log.d(tag, message)
    }

    override fun i(tag: String, message: String) {
        Log.i(tag, message)
    }

    override fun w(tag: String, message: String) {
        Log.w(tag, message)
    }

    override fun e(tag: String, message: String, throwable: Throwable?) {
        if (throwable != null) {
            Log.e(tag, message, throwable)
        } else {
            Log.e(tag, message)
        }
    }
}

/**
 * Factory function to create the appropriate logger for the platform.
 * On Android, returns AndroidLogger for proper logcat integration.
 */
actual fun createPlatformLogger(): SonyCameraLogger = AndroidLogger
