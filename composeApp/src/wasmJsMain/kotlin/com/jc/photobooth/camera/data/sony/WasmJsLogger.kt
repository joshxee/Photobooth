package com.jc.photobooth.camera.data.sony

/**
 * WasmJS-specific logger that uses println.
 */
actual fun createPlatformLogger(): SonyCameraLogger = PrintLogger
