package com.jc.photobooth.camera.data.sony

/**
 * JVM-specific logger that uses println.
 */
actual fun createPlatformLogger(): SonyCameraLogger = PrintLogger
