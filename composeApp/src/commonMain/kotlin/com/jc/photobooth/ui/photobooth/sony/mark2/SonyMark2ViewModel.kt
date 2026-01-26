package com.jc.photobooth.ui.photobooth.sony.mark2

import androidx.compose.ui.graphics.ImageBitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jc.photobooth.camera.data.sony.LiveViewStreamParser
import com.jc.photobooth.camera.data.sony.SONY_CAMERA_LOG_TAG
import com.jc.photobooth.camera.data.sony.SonyCameraApiClient
import com.jc.photobooth.camera.data.sony.SonyCameraLogger
import com.jc.photobooth.camera.data.sony.createPlatformLogger
import com.jc.photobooth.camera.data.sony.decodeImageBitmap
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.model.PhotoboothConfig
import io.ktor.client.statement.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Mark 2.0 capture state
 */
sealed class Mark2CaptureState {
    data object Idle : Mark2CaptureState()
    data class Countdown(
        val remainingSeconds: Int,
        val photoIndex: Int,
        val totalPhotos: Int
    ) : Mark2CaptureState()
    data class Capturing(val photoIndex: Int) : Mark2CaptureState()
    data class Downloading(val photoIndex: Int, val url: String) : Mark2CaptureState()
    data class PhotoPreview(
        val photo: ImageBitmap,
        val photoIndex: Int,
        val totalPhotos: Int
    ) : Mark2CaptureState()
    data class Complete(val photos: List<PhotoData>) : Mark2CaptureState()
    data class Error(val message: String) : Mark2CaptureState()
}

/**
 * Mark 2.0 UI state
 */
data class SonyMark2UiState(
    val liveViewFrame: ImageBitmap? = null,
    val captureState: Mark2CaptureState = Mark2CaptureState.Idle,
    val isConnected: Boolean = false,
    val isLiveViewActive: Boolean = false
)

/**
 * ViewModel for Sony A7 III Mark 2.0 photobooth.
 *
 * Uses actTakePicture API to capture photos and downloads them via WiFi.
 * Requires camera to be in Single Shooting mode with JPEG/RAW+JPEG format.
 *
 * Workflow:
 * 1. Show live view
 * 2. Countdown (3..2..1)
 * 3. Focus (half-press shutter)
 * 4. Capture (actTakePicture)
 * 5. Download photo from URL
 * 6. Show preview briefly
 * 7. Repeat for configured number of photos
 * 8. Navigate to photo strip
 */
class SonyMark2ViewModel(
    private val settingsRepository: SettingsRepository
) : ViewModel() {

    private val logger: SonyCameraLogger = createPlatformLogger()
    private val tag = SONY_CAMERA_LOG_TAG

    private val apiClient = SonyCameraApiClient(logger = logger)
    private val streamParser = LiveViewStreamParser()

    private val _uiState = MutableStateFlow(SonyMark2UiState())
    val uiState: StateFlow<SonyMark2UiState> = _uiState.asStateFlow()

    private var config: PhotoboothConfig = PhotoboothConfig()
    private var liveViewJob: Job? = null

    init {
        logger.i(tag, "[MARK2_VM] Initializing SonyMark2ViewModel")

        // Load settings
        viewModelScope.launch {
            settingsRepository.getConfig().collect { newConfig ->
                logger.i(tag, "[MARK2_VM] Config: photos=${newConfig.numberOfPhotos}, countdown=${newConfig.countdownSeconds}")
                config = newConfig
            }
        }
    }

    /**
     * Connect to camera and start live view
     */
    fun connect() {
        logger.i(tag, "[MARK2_VM] Connecting to camera...")

        viewModelScope.launch {
            try {
                // Test connection
                val apiResult = apiClient.getAvailableApiList()
                if (apiResult.isFailure) {
                    throw apiResult.exceptionOrNull() ?: Exception("Connection failed")
                }

                _uiState.update { it.copy(isConnected = true) }
                logger.i(tag, "[MARK2_VM] Connected to camera")

                // Start live view
                startLiveView()

            } catch (e: Exception) {
                logger.e(tag, "[MARK2_VM] Connection failed: ${e.message}", e)
                _uiState.update {
                    it.copy(
                        captureState = Mark2CaptureState.Error("Failed to connect: ${e.message}")
                    )
                }
            }
        }
    }

    private suspend fun startLiveView() {
        logger.i(tag, "[MARK2_VM] Starting live view...")

        val result = apiClient.startLiveview()
        if (result.isFailure) {
            logger.e(tag, "[MARK2_VM] Failed to start live view: ${result.exceptionOrNull()?.message}")
            return
        }

        val liveviewUrl = result.getOrNull() ?: return
        logger.i(tag, "[MARK2_VM] Live view URL: $liveviewUrl")

        _uiState.update { it.copy(isLiveViewActive = true) }

        // Start live view streaming
        liveViewJob = viewModelScope.launch {
            streamLiveView(liveviewUrl)
        }
    }

    private suspend fun streamLiveView(url: String) {
        try {
            val streamResult = apiClient.getLiveviewStream(url)
            if (streamResult.isFailure) {
                logger.e(tag, "[MARK2_VM] Failed to get live view stream")
                return
            }

            val statement = streamResult.getOrNull() ?: return

            statement.execute { response: HttpResponse ->
                val channel = response.bodyAsChannel()
                streamParser.parseFrames(channel).collect { jpegData ->
                    try {
                        val imageBitmap = decodeImageBitmap(jpegData)
                        _uiState.update { it.copy(liveViewFrame = imageBitmap) }
                    } catch (e: Exception) {
                        // Skip frames that fail to decode
                    }
                }
            }
        } catch (e: Exception) {
            logger.w(tag, "[MARK2_VM] Live view stream ended: ${e.message}")
        }
    }

    /**
     * Start the photo capture sequence
     */
    fun startCaptureSequence() {
        logger.i(tag, "[MARK2_VM] ═══════════════════════════════════════════════════")
        logger.i(tag, "[MARK2_VM] Starting Mark 2.0 capture sequence")
        logger.i(tag, "[MARK2_VM] Photos: ${config.numberOfPhotos}, Countdown: ${config.countdownSeconds}s")
        logger.i(tag, "[MARK2_VM] ═══════════════════════════════════════════════════")

        viewModelScope.launch {
            try {
                val photos = mutableListOf<PhotoData>()

                repeat(config.numberOfPhotos) { index ->
                    val photoNum = index + 1
                    logger.i(tag, "[MARK2_VM] ─── Photo $photoNum/${config.numberOfPhotos} ───")

                    // Countdown
                    for (countdown in config.countdownSeconds downTo 1) {
                        logger.d(tag, "[MARK2_VM] Countdown: $countdown")
                        _uiState.update {
                            it.copy(
                                captureState = Mark2CaptureState.Countdown(
                                    remainingSeconds = countdown,
                                    photoIndex = photoNum,
                                    totalPhotos = config.numberOfPhotos
                                )
                            )
                        }
                        delay(1000L)
                    }

                    // Capture
                    _uiState.update {
                        it.copy(captureState = Mark2CaptureState.Capturing(photoNum))
                    }

                    val photoData = captureAndDownloadPhoto(photoNum)
                    if (photoData != null) {
                        photos.add(photoData)

                        // Show preview briefly
                        try {
                            val previewBitmap = decodeImageBitmap(photoData.imageBytes)
                            _uiState.update {
                                it.copy(
                                    captureState = Mark2CaptureState.PhotoPreview(
                                        photo = previewBitmap,
                                        photoIndex = photoNum,
                                        totalPhotos = config.numberOfPhotos
                                    )
                                )
                            }
                            delay(1500L) // Show preview for 1.5 seconds
                        } catch (e: Exception) {
                            logger.w(tag, "[MARK2_VM] Failed to show preview: ${e.message}")
                        }
                    } else {
                        logger.e(tag, "[MARK2_VM] Failed to capture photo $photoNum")
                        // Continue to next photo even if one fails
                    }
                }

                // Complete
                logger.i(tag, "[MARK2_VM] ═══════════════════════════════════════════════════")
                logger.i(tag, "[MARK2_VM] Capture sequence complete! ${photos.size} photos")
                logger.i(tag, "[MARK2_VM] ═══════════════════════════════════════════════════")

                _uiState.update {
                    it.copy(captureState = Mark2CaptureState.Complete(photos))
                }

            } catch (e: Exception) {
                logger.e(tag, "[MARK2_VM] Capture sequence failed: ${e.message}", e)
                _uiState.update {
                    it.copy(captureState = Mark2CaptureState.Error(e.message ?: "Capture failed"))
                }
            }
        }
    }

    /**
     * Execute capture workflow and download photo
     */
    private suspend fun captureAndDownloadPhoto(photoIndex: Int): PhotoData? {
        logger.i(tag, "[MARK2_VM] Capturing photo $photoIndex...")

        // Execute capture workflow
        val workflowResult = apiClient.executeCaptureWorkflow()

        if (!workflowResult.success || workflowResult.imageUrls.isEmpty()) {
            logger.e(tag, "[MARK2_VM] Capture failed or no image URLs returned")
            return null
        }

        val imageUrl = workflowResult.imageUrls.first()
        logger.i(tag, "[MARK2_VM] Downloading from: $imageUrl")

        _uiState.update {
            it.copy(captureState = Mark2CaptureState.Downloading(photoIndex, imageUrl))
        }

        // Download image
        val downloadResult = apiClient.downloadImage(imageUrl)
        if (downloadResult.isFailure) {
            logger.e(tag, "[MARK2_VM] Download failed: ${downloadResult.exceptionOrNull()?.message}")
            return null
        }

        val imageBytes = downloadResult.getOrNull() ?: return null
        logger.i(tag, "[MARK2_VM] Downloaded ${imageBytes.size} bytes")

        return PhotoData(
            imageBytes = imageBytes,
            timestamp = System.currentTimeMillis()
        )
    }

    /**
     * Reset to idle state
     */
    fun resetCapture() {
        logger.i(tag, "[MARK2_VM] Resetting to idle")
        _uiState.update {
            it.copy(captureState = Mark2CaptureState.Idle)
        }
    }

    /**
     * Disconnect from camera
     */
    fun disconnect() {
        logger.i(tag, "[MARK2_VM] Disconnecting...")
        liveViewJob?.cancel()
        viewModelScope.launch {
            try {
                apiClient.stopLiveview()
            } catch (e: Exception) {
                // Ignore errors during disconnect
            }
        }
        apiClient.close()
    }

    override fun onCleared() {
        super.onCleared()
        disconnect()
    }
}
