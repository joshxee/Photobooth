package com.jc.photobooth.camera.mock

import com.jc.photobooth.camera.CameraController
import com.jc.photobooth.model.PhotoData
import kotlinx.coroutines.delay

/**
 * Mock implementation of CameraController for testing and development.
 *
 * Provides fast, hardware-free photo capture without requiring camera permissions.
 * Generates test images programmatically instead of using actual camera hardware.
 */
class MockCameraController(
    private val config: MockCameraConfig = MockCameraConfig()
) : CameraController {

    private var captureCount = 0

    override fun startPreview() {
        // No-op for mock - no actual camera preview needed
    }

    override fun stopPreview() {
        // No-op for mock
    }

    override suspend fun capturePhoto(): PhotoData {
        // Simulate capture delay
        delay(config.captureDelayMs)

        // Inject error if configured
        if (config.shouldThrowError) {
            throw Exception(config.errorMessage)
        }

        // Generate mock image bytes
        val imageBytes = MockImageGenerator.generateImageBytes(
            width = config.imageWidth,
            height = config.imageHeight,
            photoIndex = captureCount++,
            style = config.imageStyle
        )

        return PhotoData(
            imageBytes = imageBytes,
            timestamp = System.currentTimeMillis()
        )
    }

    override fun release() {
        // No-op for mock - no resources to release
    }
}
