package com.jc.photobooth.camera

import com.jc.photobooth.model.PhotoData

/**
 * JVM implementation of CameraController (Desktop).
 * This is a placeholder implementation for testing purposes.
 */
class JvmCameraController : CameraController {
    override fun startPreview() {
        // Desktop camera preview would require platform-specific libraries
    }

    override fun stopPreview() {
        // Desktop camera preview would require platform-specific libraries
    }

    override suspend fun capturePhoto(): PhotoData {
        // Return dummy photo data for testing
        return PhotoData(byteArrayOf(1, 2, 3), System.currentTimeMillis())
    }

    override fun release() {
        // Nothing to release in placeholder implementation
    }
}

actual fun createCameraController(): CameraController {
    return JvmCameraController()
}
