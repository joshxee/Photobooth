package com.jc.photobooth.camera.data.sony

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import com.jc.photobooth.camera.domain.CapturedPhoto
import com.jc.photobooth.camera.domain.ConnectionState
import com.jc.photobooth.camera.domain.PhotoMetadata
import com.jc.photobooth.camera.domain.PhotoboothCamera
import io.ktor.client.statement.*
import io.ktor.utils.io.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.jetbrains.skia.Image

/**
 * Implementation of PhotoboothCamera for Sony A7 III camera.
 * Uses WiFi-based Camera Remote API for control and image capture.
 */
class SonyA7IIICamera(
    private val cameraIp: String = "192.168.122.1",
    private val cameraPort: Int = 8080
) : PhotoboothCamera {

    override val cameraId: String = "sony_a7iii"
    override val displayName: String = "Sony A7 III"

    private val apiClient = SonyCameraApiClient(cameraIp, cameraPort)
    private val streamParser = LiveViewStreamParser()

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _liveViewFrame = MutableStateFlow<ImageBitmap?>(null)
    override val liveViewFrame: StateFlow<ImageBitmap?> = _liveViewFrame.asStateFlow()

    private val coroutineScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var liveViewJob: Job? = null
    private var liveViewUrl: String? = null

    override suspend fun connect(): Result<Unit> {
        if (_connectionState.value is ConnectionState.Connected) {
            return Result.success(Unit)
        }

        _connectionState.value = ConnectionState.Connecting

        return try {
            // Test connection by getting available API list
            val apiListResult = apiClient.getAvailableApiList()
            if (apiListResult.isFailure) {
                val error = apiListResult.exceptionOrNull()
                _connectionState.value = ConnectionState.Error(
                    "Failed to connect to camera. Make sure you're connected to the camera's WiFi network.",
                    error
                )
                return Result.failure(error ?: Exception("Connection failed"))
            }

            // Start recording mode
            val recModeResult = apiClient.startRecMode()
            if (recModeResult.isFailure) {
                val error = recModeResult.exceptionOrNull()
                _connectionState.value = ConnectionState.Error(
                    "Failed to start recording mode",
                    error
                )
                return Result.failure(error ?: Exception("Recording mode failed"))
            }

            _connectionState.value = ConnectionState.Connected
            Result.success(Unit)
        } catch (e: Exception) {
            _connectionState.value = ConnectionState.Error(
                "Connection error: ${e.message}",
                e
            )
            Result.failure(e)
        }
    }

    override suspend fun disconnect() {
        // Stop live view if active
        stopLiveView()

        // Stop recording mode
        try {
            apiClient.stopRecMode()
        } catch (e: Exception) {
            // Ignore errors during disconnect
        }

        _connectionState.value = ConnectionState.Disconnected
    }

    override suspend fun startLiveView(): Result<Unit> {
        if (_connectionState.value !is ConnectionState.Connected) {
            return Result.failure(Exception("Camera not connected"))
        }

        if (liveViewJob?.isActive == true) {
            return Result.success(Unit) // Already streaming
        }

        return try {
            val urlResult = apiClient.startLiveview()
            if (urlResult.isFailure) {
                return Result.failure(urlResult.exceptionOrNull() ?: Exception("Failed to start live view"))
            }

            liveViewUrl = urlResult.getOrThrow()

            // Start streaming in background
            liveViewJob = coroutineScope.launch {
                streamLiveView(liveViewUrl!!)
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

        try {
            apiClient.stopLiveview()
        } catch (e: Exception) {
            // Ignore errors during stop
        }
    }

    override suspend fun capture(): Result<CapturedPhoto> {
        if (_connectionState.value !is ConnectionState.Connected) {
            return Result.failure(Exception("Camera not connected"))
        }

        return try {
            // Step 1: Half-press shutter for autofocus
            val halfPressResult = apiClient.actHalfPressShutter()
            if (halfPressResult.isFailure) {
                return Result.failure(halfPressResult.exceptionOrNull() ?: Exception("Autofocus failed"))
            }

            // Wait for autofocus to complete (~300ms recommended)
            delay(300)

            // Step 2: Take picture
            val takePictureResult = apiClient.actTakePicture()
            if (takePictureResult.isFailure) {
                // Cancel half-press even if capture failed
                apiClient.cancelHalfPressShutter()
                return Result.failure(takePictureResult.exceptionOrNull() ?: Exception("Capture failed"))
            }

            val imageUrls = takePictureResult.getOrThrow()
            if (imageUrls.isEmpty()) {
                apiClient.cancelHalfPressShutter()
                return Result.failure(Exception("No image URL returned from camera"))
            }

            // Step 3: Cancel half-press
            apiClient.cancelHalfPressShutter()

            // Download the image (first URL is typically the full-size JPEG)
            val imageUrl = imageUrls.first()
            val downloadResult = apiClient.downloadImage(imageUrl)
            if (downloadResult.isFailure) {
                return Result.failure(downloadResult.exceptionOrNull() ?: Exception("Image download failed"))
            }

            val imageData = downloadResult.getOrThrow()
            val imageBitmap = decodeImage(imageData)

            Result.success(
                CapturedPhoto(
                    image = imageBitmap,
                    timestamp = System.currentTimeMillis(),
                    metadata = PhotoMetadata(
                        width = imageBitmap.width,
                        height = imageBitmap.height,
                        cameraId = cameraId,
                        format = "JPEG"
                    )
                )
            )
        } catch (e: Exception) {
            // Make sure to cancel half-press on any error
            try {
                apiClient.cancelHalfPressShutter()
            } catch (_: Exception) {
            }
            Result.failure(e)
        }
    }

    override suspend fun isAvailable(): Boolean {
        // Try to connect to camera to check availability
        return try {
            val result = apiClient.getAvailableApiList()
            result.isSuccess
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Stream live view frames in background
     */
    private suspend fun streamLiveView(url: String) {
        try {
            val streamResult = apiClient.getLiveviewStream(url)
            if (streamResult.isFailure) {
                return
            }

            val statement = streamResult.getOrThrow()
            statement.execute { response: HttpResponse ->
                val channel = response.bodyAsChannel()
                streamParser.parseFrames(channel).collect { jpegData ->
                    try {
                        val imageBitmap = decodeImage(jpegData)
                        _liveViewFrame.value = imageBitmap
                    } catch (e: Exception) {
                        // Skip frames that fail to decode
                    }
                }
            }
        } catch (e: Exception) {
            // Live view stream ended or error occurred
            _liveViewFrame.value = null
        }
    }

    /**
     * Decode JPEG byte array to ImageBitmap
     */
    private fun decodeImage(data: ByteArray): ImageBitmap {
        return Image.makeFromEncoded(data).toComposeImageBitmap()
    }

    /**
     * Clean up resources
     */
    fun close() {
        coroutineScope.cancel()
        apiClient.close()
    }
}
