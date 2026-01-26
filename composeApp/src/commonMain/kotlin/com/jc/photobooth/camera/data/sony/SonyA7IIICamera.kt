package com.jc.photobooth.camera.data.sony

import androidx.compose.ui.graphics.ImageBitmap
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

/**
 * Implementation of PhotoboothCamera for Sony A7 III camera.
 * Uses WiFi-based Camera Remote API for control and image capture.
 */
class SonyA7IIICamera(
    private val cameraIp: String = "192.168.122.1",
    private val cameraPort: Int = 10000
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
                // Error code 12 means "Already Running" - this is fine, camera is already in rec mode
                if (error is SonyCameraApiException && error.errorCode == 12) {
                    // Already in recording mode, continue
                } else {
                    _connectionState.value = ConnectionState.Error(
                        "Failed to start recording mode",
                        error
                    )
                    return Result.failure(error ?: Exception("Recording mode failed"))
                }
            }

            // Check what APIs are currently available
            println("DEBUG: Checking currently available APIs...")
            val currentApisResult = apiClient.getAvailableApiList()
            if (currentApisResult.isSuccess) {
                val apis = currentApisResult.getOrThrow()
                println("DEBUG: Available APIs (${apis.size}): $apis")

                val hasActTakePicture = apis.contains("actTakePicture")
                println("DEBUG: actTakePicture available? $hasActTakePicture")

                if (!hasActTakePicture) {
                    // Check why actTakePicture is unavailable
                    println("DEBUG: actTakePicture not available, checking why...")
                    val unavailableResult = apiClient.getTemporarilyUnavailableApiList()
                    if (unavailableResult.isSuccess) {
                        println("DEBUG: Temporarily unavailable APIs: ${unavailableResult.getOrThrow()}")
                    }

                    // Check if we have alternative shooting methods
                    val hasContShooting = apis.contains("startContShooting")
                    println("DEBUG: startContShooting available? $hasContShooting")

                    if (!hasContShooting) {
                        _connectionState.value = ConnectionState.Error(
                            "No capture methods available. Please check camera settings and mode dial.",
                            Exception("No capture APIs available")
                        )
                        return Result.failure(Exception("No capture methods available"))
                    } else {
                        println("DEBUG: Will use continuous shooting mode for capture")
                    }
                }
            } else {
                println("DEBUG: getAvailableApiList FAILED: ${currentApisResult.exceptionOrNull()}")
            }

            // Check what shoot modes are available
            println("DEBUG: Getting available shoot modes...")
            val availableModesResult = apiClient.getAvailableShootMode()
            if (availableModesResult.isSuccess) {
                val modes = availableModesResult.getOrThrow()
                println("DEBUG: Available shoot modes: $modes")
            } else {
                println("DEBUG: getAvailableShootMode FAILED: ${availableModesResult.exceptionOrNull()}")
            }

            // Try to set camera to "still" shooting mode (may fail if mode dial is set)
            println("DEBUG: Setting shoot mode to 'still'...")
            val shootModeResult = apiClient.setShootMode("still")
            if (shootModeResult.isFailure) {
                val error = shootModeResult.exceptionOrNull()
                println("DEBUG: setShootMode FAILED: $error")
                if (error is SonyCameraApiException) {
                    println("DEBUG: setShootMode error code: ${error.errorCode}")
                }
                // Continue anyway - mode dial might override, or camera already in correct mode
                println("DEBUG: Continuing despite setShootMode failure (camera may use mode dial)")
            } else {
                println("DEBUG: setShootMode SUCCESS")
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
        println("DEBUG: Stopping live view...")
        liveViewJob?.cancel()
        liveViewJob = null
        _liveViewFrame.value = null

        try {
            val result = apiClient.stopLiveview()
            if (result.isSuccess) {
                println("DEBUG: stopLiveview API call SUCCESS")
            } else {
                println("DEBUG: stopLiveview API call FAILED: ${result.exceptionOrNull()}")
            }
            // Small delay to ensure camera has processed the stop command
            delay(100)
        } catch (e: Exception) {
            println("DEBUG: stopLiveview exception: $e")
            // Still need a delay even if stop failed
            delay(100)
        }
    }

    override suspend fun capture(): Result<CapturedPhoto> {
        if (_connectionState.value !is ConnectionState.Connected) {
            return Result.failure(Exception("Camera not connected"))
        }

        return try {
            println("DEBUG: Starting capture sequence")

            // Step 0: Ensure live view is stopped (wait for camera to be ready)
            println("DEBUG: Waiting for camera to be ready for capture...")
            delay(200)

            // Step 1: Half-press shutter for autofocus
            println("DEBUG: Calling actHalfPressShutter...")
            val halfPressResult = apiClient.actHalfPressShutter()
            if (halfPressResult.isFailure) {
                val error = halfPressResult.exceptionOrNull()
                println("DEBUG: actHalfPressShutter FAILED: $error")
                if (error is SonyCameraApiException) {
                    println("DEBUG: Error code: ${error.errorCode}")
                }
                return Result.failure(error ?: Exception("Autofocus failed"))
            }
            println("DEBUG: actHalfPressShutter SUCCESS")

            // Wait for autofocus to complete (~300ms recommended)
            println("DEBUG: Waiting 300ms for autofocus...")
            delay(300)

            // Step 2: Take picture using continuous shooting
            println("DEBUG: Starting continuous shooting...")
            val startShootResult = apiClient.startContShooting()
            if (startShootResult.isFailure) {
                val error = startShootResult.exceptionOrNull()
                println("DEBUG: startContShooting FAILED: $error")
                if (error is SonyCameraApiException) {
                    println("DEBUG: Error code: ${error.errorCode}, message: ${error.message}")
                }
                // Cancel half-press even if capture failed
                apiClient.cancelHalfPressShutter()
                return Result.failure(error ?: Exception("Capture start failed"))
            }
            println("DEBUG: startContShooting SUCCESS")

            // Poll for captured images via getEvent (max 10 attempts, 200ms each = 2 seconds)
            var imageUrls: List<String> = emptyList()
            var attempts = 0
            while (imageUrls.isEmpty() && attempts < 10) {
                delay(200)
                attempts++
                println("DEBUG: Polling for images (attempt $attempts)...")

                val eventResult = apiClient.getEvent(longPolling = false)
                if (eventResult.isSuccess) {
                    val event = eventResult.getOrThrow()
                    println("DEBUG: Event data: ${event.rawData}")

                    // Look for takePicture URLs in event data
                    // Event structure varies, but typically index 40+ contains takePicture info
                    if (event.rawData.size > 40) {
                        val takePictureData = event.rawData.getOrNull(40)
                        if (takePictureData is kotlinx.serialization.json.JsonArray && takePictureData.size > 0) {
                            val urls = takePictureData.firstOrNull() as? kotlinx.serialization.json.JsonArray
                            imageUrls = urls?.map { it.toString().removeSurrounding("\"") } ?: emptyList()
                            if (imageUrls.isNotEmpty()) {
                                println("DEBUG: Found ${imageUrls.size} image URLs from event")
                            }
                        }
                    }
                }
            }

            // Stop continuous shooting
            println("DEBUG: Stopping continuous shooting...")
            apiClient.stopContShooting()
            println("DEBUG: stopContShooting called")

            println("DEBUG: Received ${imageUrls.size} image URLs: $imageUrls")

            // Step 3: Cancel half-press
            println("DEBUG: Calling cancelHalfPressShutter...")
            apiClient.cancelHalfPressShutter()
            println("DEBUG: cancelHalfPressShutter SUCCESS")

            // Mark 1.0 Workflow: Photos saved to SD card, no WiFi transfer
            if (imageUrls.isEmpty()) {
                println("DEBUG: Mark 1.0 SD Card Workflow - Photo captured to SD card (no WiFi transfer)")

                // Return success with SD card workflow message
                // Note: No actual image to display, photo is on camera SD card
                return Result.failure(Exception(
                    "Photo captured successfully!\n\n" +
                    "📸 Image saved to camera SD card\n\n" +
                    "This is the Mark 1.0 workflow - photos are not transferred via WiFi. " +
                    "Please check your camera's SD card to view the captured photo.\n\n" +
                    "TIP: Remove SD card from camera and transfer photos to view them."
                ))
            }

            // If we somehow get URLs (future camera models), download normally
            val imageUrl = imageUrls.first()
            println("DEBUG: Downloading image from: $imageUrl")
            val downloadResult = apiClient.downloadImage(imageUrl)
            if (downloadResult.isFailure) {
                println("DEBUG: Image download FAILED: ${downloadResult.exceptionOrNull()}")
                return Result.failure(downloadResult.exceptionOrNull() ?: Exception("Image download failed"))
            }

            val imageData = downloadResult.getOrThrow()
            println("DEBUG: Downloaded ${imageData.size} bytes")

            println("DEBUG: Decoding image...")
            val imageBitmap = decodeImage(imageData)
            println("DEBUG: Image decoded: ${imageBitmap.width}x${imageBitmap.height}")

            Result.success(
                CapturedPhoto(
                    image = imageBitmap,
                    timestamp = 0L, // TODO: Use proper multiplatform timestamp
                    metadata = PhotoMetadata(
                        width = imageBitmap.width,
                        height = imageBitmap.height,
                        cameraId = cameraId,
                        format = "JPEG"
                    )
                )
            )
        } catch (e: Exception) {
            println("DEBUG: Capture exception: $e")
            e.printStackTrace()
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
        return decodeImageBitmap(data)
    }

    /**
     * Helper methods for photobooth short burst capture
     */
    suspend fun actHalfPressShutter(): Result<Unit> {
        return apiClient.actHalfPressShutter()
    }

    suspend fun cancelHalfPressShutter(): Result<Unit> {
        return apiClient.cancelHalfPressShutter()
    }

    suspend fun startContShooting(): Result<List<String>> {
        return apiClient.startContShooting()
    }

    suspend fun stopContShooting(): Result<Unit> {
        return apiClient.stopContShooting()
    }

    /**
     * Clean up resources
     */
    fun close() {
        coroutineScope.cancel()
        apiClient.close()
    }
}