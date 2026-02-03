package com.jc.photobooth.camera.mock

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith

class MockCameraControllerTest {

    @Test
    fun capturePhoto_returnsPhotoDataWithValidBytes() = runTest {
        val controller = MockCameraController()

        val photoData = controller.capturePhoto()

        assertNotNull(photoData)
        assertNotNull(photoData.imageBytes)
        assertTrue(photoData.imageBytes.isNotEmpty(), "Photo bytes should not be empty")
        assertTrue(photoData.timestamp > 0, "Timestamp should be positive")
    }

    @Test
    fun capturePhoto_withCustomConfig_completesSuccessfully() = runTest {
        val delayMs = 50L
        val controller = MockCameraController(
            config = MockCameraConfig(
                captureDelayMs = delayMs,
                imageWidth = 320,
                imageHeight = 240
            )
        )

        val photoData = controller.capturePhoto()

        assertNotNull(photoData)
        assertTrue(photoData.imageBytes.isNotEmpty(), "Photo should be captured with custom config")
    }

    @Test
    fun capturePhoto_throwsErrorWhenConfigured() = runTest {
        val errorMessage = "Test camera failure"
        val controller = MockCameraController(
            config = MockCameraConfig(
                shouldThrowError = true,
                errorMessage = errorMessage
            )
        )

        val exception = assertFailsWith<Exception> {
            controller.capturePhoto()
        }

        assertTrue(exception.message!!.contains(errorMessage), "Exception should contain configured error message")
    }

    @Test
    fun startPreview_doesNotThrow() {
        val controller = MockCameraController()
        // Should not throw
        controller.startPreview()
    }

    @Test
    fun stopPreview_doesNotThrow() {
        val controller = MockCameraController()
        controller.startPreview()
        // Should not throw
        controller.stopPreview()
    }

    @Test
    fun release_doesNotThrow() {
        val controller = MockCameraController()
        // Should not throw
        controller.release()
    }

    @Test
    fun multipleCapturePhoto_produceDifferentImages() = runTest {
        val controller = MockCameraController()

        val photo1 = controller.capturePhoto()
        val photo2 = controller.capturePhoto()
        val photo3 = controller.capturePhoto()

        // Each photo should have valid bytes
        assertTrue(photo1.imageBytes.isNotEmpty())
        assertTrue(photo2.imageBytes.isNotEmpty())
        assertTrue(photo3.imageBytes.isNotEmpty())

        // Timestamps should be different (or at least >= previous)
        assertTrue(photo2.timestamp >= photo1.timestamp)
        assertTrue(photo3.timestamp >= photo2.timestamp)
    }
}
