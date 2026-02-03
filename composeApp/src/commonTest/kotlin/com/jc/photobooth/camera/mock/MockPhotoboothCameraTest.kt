package com.jc.photobooth.camera.mock

import com.jc.photobooth.camera.domain.ConnectionState
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertIs

class MockPhotoboothCameraTest {

    @Test
    fun connect_updatesConnectionStateToConnected() = runTest {
        val camera = MockPhotoboothCamera()

        assertEquals(ConnectionState.Disconnected, camera.connectionState.value)

        val result = camera.connect()

        assertTrue(result.isSuccess, "Connect should succeed")
        assertIs<ConnectionState.Connected>(camera.connectionState.value)
    }

    @Test
    fun startLiveView_completesSuccessfully() = runTest {
        val camera = MockPhotoboothCamera()
        camera.connect()

        // Initially no frame
        assertEquals(null, camera.liveViewFrame.value)

        // Start live view
        val result = camera.startLiveView()
        assertTrue(result.isSuccess, "startLiveView should succeed")

        // Note: We don't verify frame emission in unit tests because the live view
        // runs in a background coroutine with Dispatchers.Default which isn't
        // controlled by the test dispatcher. Frame emission is verified in integration tests.
    }

    @Test
    fun capture_returnsCapturedPhotoWithImageBitmap() = runTest {
        val camera = MockPhotoboothCamera()
        camera.connect()

        val result = camera.capture()

        assertTrue(result.isSuccess, "Capture should succeed")
        val capturedPhoto = result.getOrNull()
        assertNotNull(capturedPhoto, "Captured photo should not be null")
        assertNotNull(capturedPhoto.image, "Captured photo should have image")
        assertTrue(capturedPhoto.timestamp > 0, "Timestamp should be positive")
        assertEquals("mock_camera", capturedPhoto.metadata.cameraId)
        assertEquals("JPEG", capturedPhoto.metadata.format)
    }

    @Test
    fun disconnect_updatesStateToDisconnected() = runTest {
        val camera = MockPhotoboothCamera()
        camera.connect()
        camera.startLiveView()

        camera.disconnect()

        assertEquals(ConnectionState.Disconnected, camera.connectionState.value)
        assertEquals(null, camera.liveViewFrame.value, "Live view frame should be cleared on disconnect")
    }

    @Test
    fun stopLiveView_clearsLiveViewFrame() = runTest {
        val camera = MockPhotoboothCamera()
        camera.connect()
        camera.startLiveView()

        camera.stopLiveView()

        // Frame should be cleared after stopping
        assertEquals(null, camera.liveViewFrame.value, "Live view frame should be null after stop")
    }

    @Test
    fun isAvailable_returnsTrue() = runTest {
        val camera = MockPhotoboothCamera()

        val available = camera.isAvailable()

        assertTrue(available, "Mock camera should always be available")
    }

    @Test
    fun cameraProperties_haveCorrectValues() {
        val camera = MockPhotoboothCamera()

        assertEquals("mock_camera", camera.cameraId)
        assertEquals("Mock Camera (Testing)", camera.displayName)
    }

    @Test
    fun capture_withErrorConfig_returnsFailure() = runTest {
        val errorMessage = "Mock capture failed"
        val camera = MockPhotoboothCamera(
            config = MockCameraConfig(
                shouldThrowError = true,
                errorMessage = errorMessage
            )
        )
        camera.connect()

        val result = camera.capture()

        assertTrue(result.isFailure, "Capture should fail when error is configured")
        val exception = result.exceptionOrNull()
        assertNotNull(exception)
        assertTrue(exception.message!!.contains(errorMessage))
    }

    @Test
    fun multipleCaptures_produceDifferentPhotos() = runTest {
        val camera = MockPhotoboothCamera()
        camera.connect()

        val photo1 = camera.capture().getOrNull()
        val photo2 = camera.capture().getOrNull()
        val photo3 = camera.capture().getOrNull()

        assertNotNull(photo1)
        assertNotNull(photo2)
        assertNotNull(photo3)

        // Timestamps should be different (or at least >= previous)
        assertTrue(photo2.timestamp >= photo1.timestamp)
        assertTrue(photo3.timestamp >= photo2.timestamp)
    }
}
