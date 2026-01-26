package com.jc.photobooth.ui.photobooth.sony

import androidx.compose.ui.graphics.ImageBitmap

/**
 * Represents the state of live view display in the Sony photobooth.
 *
 * Live view can be either actively streaming or frozen on a captured frame.
 */
sealed class LiveViewState {
    /**
     * Live view is actively streaming frames from the camera.
     *
     * @param frame Current live view frame (null if not yet received)
     */
    data class Active(val frame: ImageBitmap?) : LiveViewState()

    /**
     * Live view is frozen on a specific frame (countdown reached 0, screenshot taken).
     *
     * @param frame The frozen frame being displayed
     */
    data class Frozen(val frame: ImageBitmap) : LiveViewState()
}

/**
 * UI state for the Sony photobooth screen.
 *
 * @param captureState Current state of the capture sequence
 * @param liveViewState Current state of the live view display
 */
data class SonyPhotoboothUiState(
    val captureState: SonyCaptureState = SonyCaptureState.Idle,
    val liveViewState: LiveViewState = LiveViewState.Active(null)
)
