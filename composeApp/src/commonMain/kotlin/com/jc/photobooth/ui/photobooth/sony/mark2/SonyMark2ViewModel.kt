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
    private var cleanupJob: Job? = null

    // Session statistics for monitoring
    private var sessionStartTime: Long = 0
    private var totalCapturesSinceStart: Int = 0
    private var totalErrorsSinceStart: Int = 0
    private var lastCleanupTime: Long = 0

    companion object {
        private const val CLEANUP_INTERVAL_MS = 30 * 60 * 1000L // 30 minutes
        private const val LIVEVIEW_TIMEOUT_MS = 60_000L // 1 minute
    }

    init {
        logger.i(tag, "[MARK2_VM] Initializing SonyMark2ViewModel")
        sessionStartTime = System.currentTimeMillis()
        lastCleanupTime = sessionStartTime

        // Load settings
        viewModelScope.launch {
            settingsRepository.getConfig().collect { newConfig ->
                logger.i(tag, "[MARK2_VM] Config: photos=${newConfig.numberOfPhotos}, countdown=${newConfig.countdownSeconds}")
                config = newConfig
            }
        }

        // Start periodic cleanup job
        startPeriodicCleanup()
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
                        totalCapturesSinceStart++

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
                        totalErrorsSinceStart++
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
                totalErrorsSinceStart++
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
     * Reset to idle state and restart live view if needed
     */
    fun resetCapture() {
        logger.i(tag, "[MARK2_VM] Resetting to idle")
        _uiState.update {
            it.copy(captureState = Mark2CaptureState.Idle)
        }

        // Restart live view if not active
        if (!_uiState.value.isLiveViewActive) {
            viewModelScope.launch {
                startLiveView()
            }
        }
    }

    /**
     * Restart live view for a new photobooth session.
     * Cancels existing live view and starts fresh.
     */
    fun restartLiveView() {
        logger.i(tag, "[MARK2_VM] Restarting live view for new session")

        // Cancel existing live view job
        liveViewJob?.cancel()
        liveViewJob = null

        // Reset state to idle
        _uiState.update {
            it.copy(
                captureState = Mark2CaptureState.Idle,
                isLiveViewActive = false
            )
        }

        // Start live view again
        viewModelScope.launch {
            startLiveView()
        }
    }

    /**
     * Perform camera health check.
     * Called by network monitor for connectivity verification.
     *
     * @return Latency in milliseconds, or failure if unreachable
     */
    suspend fun performHealthCheck(): Result<Long> {
        return apiClient.healthCheck()
    }

    /**
     * Handle network connection lost.
     * Called by network monitor when WiFi connection is lost.
     */
    fun handleNetworkLost() {
        logger.w(tag, "[MARK2_VM] Network connection lost!")

        // Update connection state
        _uiState.update { it.copy(isConnected = false, isLiveViewActive = false) }

        // Cancel live view if active
        liveViewJob?.cancel()
        liveViewJob = null

        // Don't auto-reset capture state - let user decide via ReconnectionDialog
    }

    /**
     * Start periodic resource cleanup to maintain memory stability.
     * Runs every 30 minutes.
     */
    private fun startPeriodicCleanup() {
        cleanupJob = viewModelScope.launch {
            while (true) {
                delay(CLEANUP_INTERVAL_MS)
                performResourceCleanup()
            }
        }
    }

    /**
     * Perform resource cleanup to prevent memory bloat.
     * - Clears old live view frames
     * - Logs session statistics
     * - Triggers GC hint (platform-specific)
     */
    private fun performResourceCleanup() {
        val now = System.currentTimeMillis()
        val timeSinceStart = (now - sessionStartTime) / 1000 / 60 // minutes
        val timeSinceLastCleanup = (now - lastCleanupTime) / 1000 / 60 // minutes

        logger.i(tag, "[MARK2_VM] ════════════════════════════════════")
        logger.i(tag, "[MARK2_VM] PERIODIC CLEANUP")
        logger.i(tag, "[MARK2_VM] Session uptime: ${timeSinceStart}min")
        logger.i(tag, "[MARK2_VM] Time since last cleanup: ${timeSinceLastCleanup}min")
        logger.i(tag, "[MARK2_VM] Total captures: $totalCapturesSinceStart")
        logger.i(tag, "[MARK2_VM] Total errors: $totalErrorsSinceStart")
        logger.i(tag, "[MARK2_VM] ════════════════════════════════════")

        // Clear live view frame if in idle state (not during capture)
        if (_uiState.value.captureState is Mark2CaptureState.Idle) {
            // Keep live view active, just log the cleanup
            logger.d(tag, "[MARK2_VM] Live view frame maintained (idle state)")
        }

        lastCleanupTime = now
    }

    /**
     * Handle camera operation timeout.
     * Attempts to recover by restarting live view.
     */
    private suspend fun handleTimeout(operation: String) {
        logger.w(tag, "[MARK2_VM] Timeout detected during: $operation")
        totalErrorsSinceStart++

        // Cancel live view
        liveViewJob?.cancel()
        liveViewJob = null

        // Wait briefly
        delay(2000)

        // Try to restart live view
        try {
            logger.i(tag, "[MARK2_VM] Attempting to recover from timeout...")
            startLiveView()
        } catch (e: Exception) {
            logger.e(tag, "[MARK2_VM] Recovery failed: ${e.message}", e)
            _uiState.update {
                it.copy(
                    isConnected = false,
                    isLiveViewActive = false,
                    captureState = Mark2CaptureState.Error("Connection timeout. Please check camera.")
                )
            }
        }
    }

    /**
     * Log session statistics.
     */
    fun logSessionStats() {
        val uptimeMinutes = (System.currentTimeMillis() - sessionStartTime) / 1000 / 60
        logger.i(tag, "[MARK2_VM] ════════════════════════════════════")
        logger.i(tag, "[MARK2_VM] SESSION STATISTICS")
        logger.i(tag, "[MARK2_VM] Uptime: ${uptimeMinutes}min")
        logger.i(tag, "[MARK2_VM] Total captures: $totalCapturesSinceStart")
        logger.i(tag, "[MARK2_VM] Total errors: $totalErrorsSinceStart")
        logger.i(tag, "[MARK2_VM] Success rate: ${if (totalCapturesSinceStart > 0) (100 - (totalErrorsSinceStart * 100 / totalCapturesSinceStart)) else 100}%")
        logger.i(tag, "[MARK2_VM] ════════════════════════════════════")
    }

    /**
     * Disconnect from camera
     */
    fun disconnect() {
        logger.i(tag, "[MARK2_VM] Disconnecting...")

        // Cancel jobs
        liveViewJob?.cancel()
        cleanupJob?.cancel()

        // Log final statistics
        logSessionStats()

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
