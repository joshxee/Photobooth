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
import com.jc.photobooth.gesture.GestureDetector
import com.jc.photobooth.gesture.GestureResult
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.model.PhotoboothConfig
import io.ktor.client.statement.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * State of the background auto-reconnection loop.
 *
 * Transitions:
 *   Idle → InProgress (on disconnect)
 *   InProgress → Idle (on successful reconnect)
 *   InProgress → GaveUp (after RECONNECT_TIMEOUT_MS with no success)
 *   GaveUp → InProgress (on manual retry)
 *   Any → Idle (on user dismiss or successful connection)
 */
sealed class AutoReconnectState {
    /** Not reconnecting — either never disconnected or successfully connected. */
    data object Idle : AutoReconnectState()

    /** Actively attempting to reconnect. */
    data class InProgress(val attemptNumber: Int) : AutoReconnectState()

    /** Gave up after exceeding the reconnection timeout. */
    data object GaveUp : AutoReconnectState()
}

/**
 * Mark 2.0 UI state
 */
data class SonyMark2UiState(
    val liveViewFrame: ImageBitmap? = null,
    val isConnected: Boolean = false,
    val isLiveViewActive: Boolean = false,
    val gestureResult: GestureResult? = null,
    val autoReconnect: AutoReconnectState = AutoReconnectState.Idle,
    val connectionError: String? = null
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
    private val settingsRepository: SettingsRepository,
    private val gestureDetector: GestureDetector? = null
) : ViewModel() {

    private val logger: SonyCameraLogger = createPlatformLogger()
    private val tag = SONY_CAMERA_LOG_TAG

    private val apiClient = SonyCameraApiClient(logger = logger)
    private val streamParser = LiveViewStreamParser()

    private val _uiState = MutableStateFlow(SonyMark2UiState())
    val uiState: StateFlow<SonyMark2UiState> = _uiState.asStateFlow()

    /**
     * Emits when sustained palm gesture is detected. The host's PhotoboothFlow
     * collects this only during the Attract stage to advance to Countdown.
     */
    private val _startSignal = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val startSignal: SharedFlow<Unit> = _startSignal.asSharedFlow()

    private var config: PhotoboothConfig = PhotoboothConfig()
    private var liveViewJob: Job? = null
    private var cleanupJob: Job? = null
    private var gestureCollectorJob: Job? = null
    private var staleDetectionJob: Job? = null
    private var reconnectJob: Job? = null

    // Sustained palm detection tracking
    private var firstPalmDetectionTime: Long? = null
    private var lastPalmDetectionTime: Long? = null
    private var lastFrameProcessedTime: Long = 0

    // Timestamp of the last successfully decoded live view frame.
    // Read and written only from viewModelScope coroutines (main thread on Android).
    private var lastFrameTimestamp: Long = 0L

    // Session statistics for monitoring
    private var sessionStartTime: Long = 0
    private var totalCapturesSinceStart: Int = 0
    private var totalErrorsSinceStart: Int = 0
    private var lastCleanupTime: Long = 0

    companion object {
        private const val CLEANUP_INTERVAL_MS = 30 * 60 * 1000L // 30 minutes
        private const val LIVEVIEW_TIMEOUT_MS = 60_000L // 1 minute
        private const val GESTURE_FRAME_INTERVAL_MS = 150L // ~6.5 FPS for gesture processing
        private const val SUSTAINED_PALM_DURATION_MS = 800L // 0.8 seconds to trigger
        private const val GESTURE_GAP_GRACE_MS = 250L       // Allow brief null gaps before resetting sustained timer

        // Stale frame detection — lightweight, checked every few seconds.
        private const val STALE_FRAME_THRESHOLD_MS = 5_000L  // No frame for 5s → stale
        private const val STALE_CHECK_INTERVAL_MS = 3_000L   // Poll every 3s

        // Auto-reconnect backoff
        private const val RECONNECT_TIMEOUT_MS = 60_000L     // Give up after 1 minute total
        private const val RECONNECT_INITIAL_DELAY_MS = 2_000L
        private const val RECONNECT_MAX_BACKOFF_MS = 30_000L // Cap individual delay at 30s
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

        // Start gesture detection collection if available
        startGestureCollection()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Connection management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Connect to camera and start live view.
     * Cancels any ongoing auto-reconnect loop — this is a fresh manual attempt.
     */
    fun connect() {
        logger.i(tag, "[MARK2_VM] Connecting to camera...")
        reconnectJob?.cancel()
        reconnectJob = null

        viewModelScope.launch {
            val connected = attemptConnection()
            if (!connected) {
                _uiState.update { it.copy(connectionError = "Failed to connect to camera") }
            }
        }
    }

    /**
     * Manually retry connection. Cancels the current auto-reconnect state and
     * starts a fresh reconnect loop (another full 60-second window).
     * Called when the user taps "Retry Connection" in the reconnection dialog.
     */
    fun manualRetry() {
        logger.i(tag, "[MARK2_VM] Manual retry triggered")
        reconnectJob?.cancel()
        startAutoReconnect()
    }

    /**
     * Dismiss the reconnection dialog without reconnecting.
     * Stops auto-reconnect and resets to idle, so the user can continue
     * with a frozen frame or navigate away.
     */
    fun dismissReconnection() {
        logger.i(tag, "[MARK2_VM] Reconnection dismissed by user")
        reconnectJob?.cancel()
        reconnectJob = null
        _uiState.update {
            it.copy(autoReconnect = AutoReconnectState.Idle)
        }
    }

    /**
     * Attempt a single connection to the camera.
     * On success, updates state and starts live view.
     *
     * @return true if the connection succeeded
     */
    private suspend fun attemptConnection(): Boolean {
        return try {
            val result = apiClient.getAvailableApiList()
            if (result.isFailure) return false

            _uiState.update {
                it.copy(
                    isConnected = true,
                    autoReconnect = AutoReconnectState.Idle
                )
            }
            logger.i(tag, "[MARK2_VM] Connected to camera")
            startLiveView()
            true
        } catch (e: Exception) {
            logger.e(tag, "[MARK2_VM] Connection attempt failed: ${e.message}", e)
            false
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Live view streaming
    // ─────────────────────────────────────────────────────────────────────────

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

        liveViewJob = viewModelScope.launch {
            streamLiveView(liveviewUrl)
        }

        startStaleDetection()
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
                        lastFrameTimestamp = System.currentTimeMillis()
                        _uiState.update { it.copy(liveViewFrame = imageBitmap) }
                        processFrameForGesture(jpegData)
                    } catch (e: Exception) {
                        // Skip frames that fail to decode — don't reset timestamp
                        // so a single bad frame doesn't trigger stale detection
                    }
                }
            }
        } catch (e: Exception) {
            logger.w(tag, "[MARK2_VM] Live view stream ended: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Stale frame detection
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts a lightweight background watcher that detects a stalled live view stream.
     *
     * The watcher wakes up every [STALE_CHECK_INTERVAL_MS] seconds and compares
     * the current time to [lastFrameTimestamp]. If the stream has been silent for
     * longer than [STALE_FRAME_THRESHOLD_MS] it is declared stale and
     * [handleNetworkLost] is called to trigger reconnection.
     *
     * The initial frame-wait loop avoids false positives during connection setup,
     * where frames haven't started arriving yet.
     */
    private fun startStaleDetection() {
        staleDetectionJob?.cancel()
        staleDetectionJob = viewModelScope.launch {

            // Wait until the first frame arrives before watching for stalls.
            while (isActive && lastFrameTimestamp == 0L) {
                delay(STALE_CHECK_INTERVAL_MS)
            }

            while (isActive) {
                delay(STALE_CHECK_INTERVAL_MS)
                val staleDurationMs = System.currentTimeMillis() - lastFrameTimestamp
                if (staleDurationMs > STALE_FRAME_THRESHOLD_MS) {
                    logger.w(tag, "[MARK2_VM] Live view stale for ${staleDurationMs}ms — triggering reconnection")
                    handleLiveViewStale()
                    break
                }
            }
        }
    }

    private fun handleLiveViewStale() {
        lastFrameTimestamp = 0L
        handleNetworkLost()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Auto-reconnection
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts an exponential-backoff reconnection loop.
     *
     * Attempts: immediately, then after 2s, 4s, 8s, 16s, 30s, 30s, …
     * Gives up after [RECONNECT_TIMEOUT_MS] (1 minute) total elapsed time.
     *
     * The [AutoReconnectState] in [uiState] is updated on every attempt so
     * the UI can show live progress to the user.
     */
    private fun startAutoReconnect() {
        reconnectJob = viewModelScope.launch {
            val deadline = System.currentTimeMillis() + RECONNECT_TIMEOUT_MS
            var attempt = 0

            while (isActive && System.currentTimeMillis() < deadline) {
                attempt++
                logger.i(tag, "[MARK2_VM] Auto-reconnect attempt $attempt")
                _uiState.update { it.copy(autoReconnect = AutoReconnectState.InProgress(attempt)) }

                val connected = attemptConnection()
                if (connected) {
                    logger.i(tag, "[MARK2_VM] Auto-reconnect succeeded on attempt $attempt")
                    return@launch
                }

                val remainingMs = deadline - System.currentTimeMillis()
                if (remainingMs <= 0) break

                val backoffMs = (RECONNECT_INITIAL_DELAY_MS shl (attempt - 1))
                    .coerceAtMost(RECONNECT_MAX_BACKOFF_MS)
                    .coerceAtMost(remainingMs)

                logger.d(tag, "[MARK2_VM] Backoff ${backoffMs}ms before next attempt (${remainingMs}ms remaining)")
                delay(backoffMs)
            }

            logger.w(tag, "[MARK2_VM] Auto-reconnect gave up after $attempt attempts")
            _uiState.update { it.copy(autoReconnect = AutoReconnectState.GaveUp) }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Network events
    // ─────────────────────────────────────────────────────────────────────────

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
     * Called by network monitor when WiFi drops, or when the live view stream goes stale.
     * Cancels the live view and starts the auto-reconnect loop.
     */
    fun handleNetworkLost() {
        logger.w(tag, "[MARK2_VM] Network connection lost — starting auto-reconnect")

        staleDetectionJob?.cancel()
        staleDetectionJob = null

        liveViewJob?.cancel()
        liveViewJob = null
        lastFrameTimestamp = 0L

        _uiState.update { it.copy(isConnected = false, isLiveViewActive = false) }

        // Only start if not already reconnecting (e.g. health check and stale detection both fire)
        if (reconnectJob?.isActive != true) {
            startAutoReconnect()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capture
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Capture a single photo via the Sony Mark 2 WiFi-transfer workflow.
     * Called once per shot by the host's [com.jc.photobooth.ui.photobooth.PhotoboothHost].
     *
     * Throws on failure so the host's runCatching can fall back to a placeholder
     * frame and surface the error via the host's error slot.
     */
    suspend fun captureSingle(): PhotoData {
        // Clear gesture state when a capture starts
        firstPalmDetectionTime = null
        lastPalmDetectionTime = null
        _uiState.update { it.copy(gestureResult = null) }

        logger.i(tag, "[MARK2_VM] Capturing single photo…")

        val workflowResult = try {
            apiClient.executeCaptureWorkflow()
        } catch (e: Exception) {
            totalErrorsSinceStart++
            throw e
        }

        if (!workflowResult.success || workflowResult.imageUrls.isEmpty()) {
            totalErrorsSinceStart++
            throw IllegalStateException("Capture failed or no image URLs returned")
        }

        val imageUrl = workflowResult.imageUrls.first()
        val downloadResult = apiClient.downloadImage(imageUrl)
        val imageBytes = downloadResult.getOrElse {
            totalErrorsSinceStart++
            throw it
        }

        totalCapturesSinceStart++
        return PhotoData(
            imageBytes = imageBytes,
            timestamp = System.currentTimeMillis()
        )
    }

    /**
     * Restart live view for a new photobooth session.
     * Cancels existing live view and starts fresh.
     */
    fun restartLiveView() {
        logger.i(tag, "[MARK2_VM] Restarting live view for new session")

        staleDetectionJob?.cancel()
        staleDetectionJob = null

        liveViewJob?.cancel()
        liveViewJob = null
        lastFrameTimestamp = 0L

        _uiState.update { it.copy(isLiveViewActive = false) }

        // Start live view again
        viewModelScope.launch {
            startLiveView()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Maintenance
    // ─────────────────────────────────────────────────────────────────────────

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

        lastCleanupTime = now
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
     * Process a live view frame for gesture detection.
     * Throttled to ~6.5 FPS and only active when idle and connected.
     */
    private fun processFrameForGesture(jpegData: ByteArray) {
        val detector = gestureDetector ?: return
        if (!_uiState.value.isConnected) return

        val now = System.currentTimeMillis()
        if (now - lastFrameProcessedTime < GESTURE_FRAME_INTERVAL_MS) return
        lastFrameProcessedTime = now

        detector.processFrame(jpegData, now)
    }

    /**
     * Collect gesture detection results and track sustained palm detection.
     * After 2 seconds of continuous Open_Palm, auto-triggers capture sequence.
     */
    private fun startGestureCollection() {
        val detector = gestureDetector ?: return
        logger.i(tag, "[MARK2_VM] Starting gesture detection collection")

        gestureCollectorJob = viewModelScope.launch {
            detector.results.collect { result ->
                if (!_uiState.value.isConnected) return@collect

                _uiState.update { it.copy(gestureResult = result) }

                val now = System.currentTimeMillis()
                if (result != null) {
                    lastPalmDetectionTime = now
                    if (firstPalmDetectionTime == null) {
                        firstPalmDetectionTime = now
                        logger.d(tag, "[MARK2_VM] Palm detected - starting sustained timer")
                    } else {
                        val elapsed = now - (firstPalmDetectionTime ?: now)
                        if (elapsed >= SUSTAINED_PALM_DURATION_MS) {
                            logger.i(tag, "[MARK2_VM] Sustained palm — emitting startSignal")
                            firstPalmDetectionTime = null
                            lastPalmDetectionTime = null
                            _startSignal.tryEmit(Unit)
                        }
                    }
                } else if (firstPalmDetectionTime != null) {
                    val gapMs = now - (lastPalmDetectionTime ?: now)
                    if (gapMs > GESTURE_GAP_GRACE_MS) {
                        logger.d(tag, "[MARK2_VM] Palm lost >250ms - resetting sustained timer")
                        firstPalmDetectionTime = null
                        lastPalmDetectionTime = null
                    }
                }
            }
        }
    }

    /**
     * Disconnect from camera and cancel all background jobs.
     */
    fun disconnect() {
        logger.i(tag, "[MARK2_VM] Disconnecting...")

        staleDetectionJob?.cancel()
        reconnectJob?.cancel()
        liveViewJob?.cancel()
        cleanupJob?.cancel()
        gestureCollectorJob?.cancel()

        // Close gesture detector
        gestureDetector?.close()

        logSessionStats()

        viewModelScope.launch {
            try {
                apiClient.stopLiveview()
            } catch (e: Exception) {
                logger.w(tag, "[MARK2_VM] Failed to stop live view: ${e.message}")
            }
        }
        apiClient.close()
    }

    override fun onCleared() {
        super.onCleared()
        disconnect()
    }
}
