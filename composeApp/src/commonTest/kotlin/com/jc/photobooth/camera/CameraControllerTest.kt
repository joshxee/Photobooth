package com.jc.photobooth.camera

import com.jc.photobooth.model.PhotoData
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class CameraControllerTest {

    @Test
    fun testCameraControllerInterfaceCanBeImplemented() {
        val controller: CameraController = TestCameraController()
        assertNotNull(controller)
    }

    @Test
    fun testStartPreviewDoesNotThrow() {
        val controller = TestCameraController()
        // Should not throw
        controller.startPreview()
    }

    @Test
    fun testStopPreviewDoesNotThrow() {
        val controller = TestCameraController()
        // Should not throw
        controller.stopPreview()
    }

    @Test
    fun testCapturePhotoReturnsPhotoData() = runTest {
        val controller = TestCameraController()
        val photo = controller.capturePhoto()
        assertNotNull(photo)
        assertTrue(photo.imageBytes.isNotEmpty())
        assertTrue(photo.timestamp > 0)
    }

    @Test
    fun testReleaseDoesNotThrow() {
        val controller = TestCameraController()
        // Should not throw
        controller.release()
    }
}

/**
 * Test implementation of CameraController for testing purposes.
 */
class TestCameraController : CameraController {
    override fun startPreview() {}
    override fun stopPreview() {}
    override suspend fun capturePhoto(): PhotoData = PhotoData(byteArrayOf(1, 2, 3), System.currentTimeMillis())
    override fun release() {}
}
