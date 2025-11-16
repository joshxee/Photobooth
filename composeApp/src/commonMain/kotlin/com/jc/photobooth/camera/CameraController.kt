package com.jc.photobooth.camera

import com.jc.photobooth.model.PhotoData

/**
 * Interface for controlling camera operations across platforms.
 *
 * Platform-specific implementations should be provided via the expect/actual pattern.
 */
interface CameraController {
    /**
     * Start the camera preview.
     * This initializes the camera and begins showing the camera feed.
     */
    fun startPreview()

    /**
     * Stop the camera preview.
     * This stops the camera feed and releases camera resources temporarily.
     */
    fun stopPreview()

    /**
     * Capture a photo from the camera.
     *
     * @return PhotoData containing the captured image bytes and timestamp
     */
    suspend fun capturePhoto(): PhotoData

    /**
     * Release all camera resources.
     * This should be called when the camera is no longer needed (e.g., when leaving the screen).
     */
    fun release()
}

/**
 * Factory function to create a platform-specific CameraController.
 * This is an expect declaration that will be implemented differently on each platform.
 */
expect fun createCameraController(): CameraController
