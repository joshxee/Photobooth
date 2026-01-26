package com.jc.photobooth.camera.data.sony

/**
 * iOS-specific logger that uses println.
 */
actual fun createPlatformLogger(): SonyCameraLogger = PrintLogger
