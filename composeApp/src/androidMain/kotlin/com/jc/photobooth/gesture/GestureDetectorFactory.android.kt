package com.jc.photobooth.gesture

import android.content.Context

private lateinit var appContext: Context

fun initGestureDetectorContext(context: Context) {
    appContext = context.applicationContext
}

actual fun createGestureDetector(): GestureDetector? {
    if (!::appContext.isInitialized) return null
    return try {
        MediaPipeGestureDetector(appContext)
    } catch (e: Exception) {
        android.util.Log.e("GestureDetector", "Failed to create gesture detector: ${e.message}", e)
        null
    }
}
