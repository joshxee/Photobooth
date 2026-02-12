package com.jc.photobooth.ui.photobooth.sony

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jc.photobooth.camera.data.sony.SonyA7IIICamera
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.util.encodeImageBitmapToJpeg
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * ViewModel for Sony A7 III photobooth screen (Mark 1.1 - Screenshot Workflow).
 *
 * Manages the capture sequence:
 * 1. Countdown with live view active
 * 2. Freeze live view at countdown 0
 * 3. Screenshot frozen frame
 * 4. Trigger camera capture (continuous shooting → SD card)
 * 5. Unfreeze for next photo
 * 6. Navigate to photo strip when complete
 *
 * @param camera Sony A7 III camera instance
 * @param settingsRepository Settings repository for photobooth configuration
 */
class SonyPhotoboothViewModel(
    private val camera: SonyA7IIICamera,
    private val settingsRepository: SettingsRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(SonyPhotoboothUiState())
    val uiState: StateFlow<SonyPhotoboothUiState> = _uiState.asStateFlow()

    private var config: PhotoboothConfig = PhotoboothConfig()
    private var frameCount = 0 // For throttling log output

    init {
        println("[SONY_PB_VM] Initializing SonyPhotoboothViewModel")
        println("[SONY_PB_VM] Camera instance: $camera")
        println("[SONY_PB_VM] Camera connection state: ${camera.connectionState.value}")

        // Monitor live view frames
        viewModelScope.launch {
            camera.liveViewFrame.collect { frame ->
                // Update UI state with active live view (during Idle AND Countdown)
                val currentState = _uiState.value.captureState
                if (currentState is SonyCaptureState.Idle || currentState is SonyCaptureState.Countdown) {
                    _uiState.update {
                        it.copy(liveViewState = LiveViewState.Active(frame))
                    }
                }
            }
        }

        // Load settings
        viewModelScope.launch {
            settingsRepository.getConfig().collect { newConfig ->
                println("[SONY_PB_VM] Config updated: numberOfPhotos=${newConfig.numberOfPhotos}, countdownSeconds=${newConfig.countdownSeconds}")
                config = newConfig
            }
        }
    }

    /**
     * Start the photo capture sequence.
     *
     * Captures [config.numberOfPhotos] photos with [config.countdownSeconds] countdown.
     * Uses continuous shooting mode (ONLY method available on Sony A7 III).
     *
     * Minimal delays: Only countdown timer (1000ms/sec), NO artificial waits.
     */
    fun startCaptureSequence() {
        println("[SONY_PB_VM] startCaptureSequence() called")
        println("[SONY_PB_VM] Config: numberOfPhotos=${config.numberOfPhotos}, countdownSeconds=${config.countdownSeconds}")

        viewModelScope.launch {
            try {
                val photos = mutableListOf<PhotoData>()

                repeat(config.numberOfPhotos) { index ->
                    println("[SONY_PB_VM] Starting photo ${index + 1}/${config.numberOfPhotos}")

                    // Countdown phase with smart autofocus timing
                    var isFocused = false

                    for (countdown in config.countdownSeconds downTo 1) {
                        println("[SONY_PB_VM] Countdown: $countdown (photo ${index + 1})")
                        _uiState.update {
                            it.copy(
                                captureState = SonyCaptureState.Countdown(
                                    remainingSeconds = countdown,
                                    photoIndex = index + 1,
                                    totalPhotos = config.numberOfPhotos
                                )
                            )
                        }

                        // Start autofocus at countdown 1 (runs in background during final second)
                        if (countdown == 1) {
                            println("[SONY_PB_VM] Starting autofocus in background...")
                            try {
                                camera.actHalfPressShutter()
                                isFocused = true
                                // Don't wait - let it focus during the final countdown second
                            } catch (e: Exception) {
                                println("[SONY_PB_VM] Autofocus failed: ${e.message}")
                            }
                        }

                        delay(1000L)
                    }

                    // At countdown 0: Take screenshot (this is the "photo" moment)
                    val currentFrame = camera.liveViewFrame.value
                    println("[SONY_PB_VM] Capturing frame: ${currentFrame != null}, size: ${currentFrame?.width}x${currentFrame?.height}")

                    if (currentFrame == null) {
                        throw Exception("No live view frame available")
                    }

                    // Screenshot current frame (synchronous, ~50ms)
                    println("[SONY_PB_VM] Encoding screenshot...")
                    val startTime = System.currentTimeMillis()
                    val photoBytes = encodeImageBitmapToJpeg(currentFrame, quality = 90)
                    val encodeTime = System.currentTimeMillis() - startTime
                    println("[SONY_PB_VM] Screenshot encoded: ${photoBytes.size} bytes in ${encodeTime}ms")

                    val photoData = PhotoData(
                        imageBytes = photoBytes,
                        timestamp = System.currentTimeMillis()
                    )
                    photos.add(photoData)

                    // Show capture state with white border
                    _uiState.update {
                        it.copy(
                            captureState = SonyCaptureState.Capturing(photoIndex = index + 1)
                        )
                    }

                    // Trigger camera shutter (uses pre-focused state if successful)
                    println("[SONY_PB_VM] Triggering camera shutter...")
                    val captureStartTime = System.currentTimeMillis()

                    try {
                        // If focus wasn't started earlier, do it now
                        if (!isFocused) {
                            camera.actHalfPressShutter()
                            delay(300)
                        } else {
                            // Give a bit more time for focus to lock (already started 1 sec ago)
                            delay(100)
                        }

                        // Start continuous shooting
                        camera.startContShooting()
                        delay(100) // Brief burst

                        // Stop continuous shooting
                        camera.stopContShooting()
                        camera.cancelHalfPressShutter()

                        val captureDuration = System.currentTimeMillis() - captureStartTime
                        println("[SONY_PB_VM] Camera shutter completed in ${captureDuration}ms")
                    } catch (e: Exception) {
                        println("[SONY_PB_VM] ERROR during camera trigger: ${e.message}")
                        try {
                            camera.cancelHalfPressShutter()
                        } catch (cancelError: Exception) {
                            println("[SONY_PB_VM] Error canceling half-press: ${cancelError.message}")
                        }
                    }

                    // Live view remains active between photos
                }

                // Sequence complete
                println("[SONY_PB_VM] Capture sequence complete! Total photos: ${photos.size}")
                _uiState.update {
                    it.copy(
                        captureState = SonyCaptureState.Complete(photos)
                    )
                }

            } catch (e: Exception) {
                println("[SONY_PB_VM] ERROR in capture sequence: ${e.message}")
                e.printStackTrace()
                _uiState.update {
                    it.copy(
                        captureState = SonyCaptureState.Error(
                            message = e.message ?: "Capture failed"
                        )
                    )
                }
            }
        }
    }

    /**
     * Reset capture state to Idle (ready for next sequence).
     */
    fun resetCapture() {
        println("[SONY_PB_VM] resetCapture() called")
        _uiState.update {
            it.copy(
                captureState = SonyCaptureState.Idle,
                liveViewState = LiveViewState.Active(camera.liveViewFrame.value)
            )
        }
        println("[SONY_PB_VM] State reset to Idle, live view: ${camera.liveViewFrame.value != null}")
    }
}
