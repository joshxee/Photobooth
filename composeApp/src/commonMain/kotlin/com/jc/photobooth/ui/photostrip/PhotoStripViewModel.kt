package com.jc.photobooth.ui.photostrip

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jc.photobooth.model.PhotoData
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * UI state for the photo strip screen.
 *
 * @property photos List of captured photos to display
 * @property countdownSeconds Total countdown duration
 * @property countdownRemaining Remaining seconds in countdown
 * @property isCountdownActive Whether countdown is currently running
 */
data class PhotoStripUiState(
    val photos: List<PhotoData> = emptyList(),
    val countdownSeconds: Int = 10,
    val countdownRemaining: Int = 10,
    val isCountdownActive: Boolean = true
)

/**
 * ViewModel for managing photo strip display and countdown state.
 *
 * Handles countdown timer logic for auto-return to live view.
 */
class PhotoStripViewModel(
    private val countdownDurationSeconds: Int = 10
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        PhotoStripUiState(
            countdownSeconds = countdownDurationSeconds,
            countdownRemaining = countdownDurationSeconds,
            isCountdownActive = true // Auto-start countdown
        )
    )
    val uiState: StateFlow<PhotoStripUiState> = _uiState.asStateFlow()

    private var countdownJob: Job? = null

    /**
     * Callback invoked when countdown reaches zero.
     * Should be set by the caller to handle navigation back to live view.
     */
    var onCountdownComplete: (() -> Unit)? = null

    /**
     * Start the countdown timer.
     */
    fun startCountdown() {
        // Cancel any existing countdown
        countdownJob?.cancel()

        // Ensure we start from current remaining time
        if (_uiState.value.countdownRemaining == 0) {
            _uiState.update { it.copy(countdownRemaining = countdownDurationSeconds) }
        }

        _uiState.update { it.copy(isCountdownActive = true) }

        countdownJob = viewModelScope.launch {
            while (_uiState.value.countdownRemaining > 0) {
                delay(1000)
                _uiState.update {
                    it.copy(countdownRemaining = it.countdownRemaining - 1)
                }
            }

            // Countdown complete
            _uiState.update { it.copy(isCountdownActive = false) }
            onCountdownComplete?.invoke()
        }
    }

    /**
     * Pause the countdown timer.
     */
    fun pauseCountdown() {
        countdownJob?.cancel()
        _uiState.update { it.copy(isCountdownActive = false) }
    }

    /**
     * Resume the countdown timer from current remaining time.
     */
    fun resumeCountdown() {
        if (_uiState.value.countdownRemaining > 0) {
            startCountdown()
        }
    }

    /**
     * Reset the countdown to initial duration without starting.
     */
    fun resetCountdown() {
        countdownJob?.cancel()
        _uiState.update {
            it.copy(
                countdownRemaining = countdownDurationSeconds,
                isCountdownActive = false
            )
        }
    }

    /**
     * Skip countdown and immediately trigger completion callback.
     */
    fun skipCountdown() {
        countdownJob?.cancel()
        _uiState.update {
            it.copy(
                countdownRemaining = 0,
                isCountdownActive = false
            )
        }
        onCountdownComplete?.invoke()
    }

    /**
     * Set the photos to display.
     */
    fun setPhotos(photos: List<PhotoData>) {
        _uiState.update { it.copy(photos = photos) }
    }

    /**
     * Clear photos from memory to prevent memory leaks.
     * Call this after navigation back to live view.
     */
    fun clearPhotos() {
        _uiState.update { it.copy(photos = emptyList()) }
    }

    override fun onCleared() {
        super.onCleared()
        countdownJob?.cancel()
        // Clear photos on disposal
        clearPhotos()
    }
}
