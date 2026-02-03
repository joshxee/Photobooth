package com.jc.photobooth.camera.mock

import androidx.compose.ui.graphics.ImageBitmap
import com.jc.photobooth.camera.domain.CapturedPhoto
import com.jc.photobooth.camera.domain.ConnectionState
import com.jc.photobooth.camera.domain.PhotoMetadata
import com.jc.photobooth.camera.domain.PhotoboothCamera
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Mock implementation of PhotoboothCamera for testing and development.
 *
 * Provides a hardware-free camera implementation that:
 * - Generates live view frames programmatically (~30fps)
 * - Captures mock photos with different colors
 * - Works on all platforms without camera permissions
 * - Enables fast UI/UX iteration and automated testing
 */
class MockPhotoboothCamera(
    private val config: MockCameraConfig = MockCameraConfig()
) : PhotoboothCamera {

    override val cameraId: String = "mock_camera"
    override val displayName: String = "Mock Camera (Testing)"

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _liveViewFrame = MutableStateFlow<ImageBitmap?>(null)
    override val liveViewFrame: StateFlow<ImageBitmap?> = _liveViewFrame.asStateFlow()

    private var liveViewJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var captureCount = 0

    override suspend fun connect(): Result<Unit> {
        return try {
            delay(200) // Simulate connection time
            _connectionState.value = ConnectionState.Connected
            Result.success(Unit)
        } catch (e: Exception) {
            _connectionState.value = ConnectionState.Error("Connection failed", e)
            Result.failure(e)
        }
    }

    override suspend fun disconnect() {
        liveViewJob?.cancel()
        _liveViewFrame.value = null
        _connectionState.value = ConnectionState.Disconnected
    }

    override suspend fun startLiveView(): Result<Unit> {
        return try {
            liveViewJob?.cancel()

            liveViewJob = scope.launch {
                var frameIndex = 0
                while (isActive) {
                    _liveViewFrame.value = MockImageGenerator.generateImageBitmap(
                        width = config.imageWidth,
                        height = config.imageHeight,
                        photoIndex = frameIndex++ / 30, // Change color every second at 30fps
                        style = config.imageStyle
                    )
                    delay(33) // ~30fps
                }
            }

            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    override suspend fun stopLiveView() {
        liveViewJob?.cancel()
        liveViewJob = null
        _liveViewFrame.value = null
    }

    override suspend fun capture(): Result<CapturedPhoto> {
        return try {
            // Simulate capture delay
            delay(config.captureDelayMs)

            // Inject error if configured
            if (config.shouldThrowError) {
                throw Exception(config.errorMessage)
            }

            // Generate mock image
            val imageBitmap = MockImageGenerator.generateImageBitmap(
                width = config.imageWidth,
                height = config.imageHeight,
                photoIndex = captureCount++,
                style = config.imageStyle
            )

            Result.success(
                CapturedPhoto(
                    image = imageBitmap,
                    timestamp = System.currentTimeMillis(),
                    metadata = PhotoMetadata(
                        width = config.imageWidth,
                        height = config.imageHeight,
                        cameraId = cameraId,
                        format = "JPEG"
                    )
                )
            )
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    override suspend fun isAvailable(): Boolean = true
}
