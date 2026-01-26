package com.jc.photobooth.camera.data.sony

/**
 * JS-specific logger that uses println (console.log).
 */
actual fun createPlatformLogger(): SonyCameraLogger = PrintLogger
