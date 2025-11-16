package com.jc.photobooth.ui.photobooth

import com.jc.photobooth.model.PhotoData

/**
 * Represents the current state of the photo capture process.
 */
sealed class CaptureState {
    /** Ready to start capture */
    object Idle : CaptureState()

    /** Countdown in progress before taking photo */
    data class Countdown(
        val remainingSeconds: Int,
        val photoIndex: Int,
        val totalPhotos: Int
    ) : CaptureState()

    /** Currently capturing photo */
    data class Capturing(val photoIndex: Int) : CaptureState()

    /** All photos captured successfully */
    data class Complete(val photos: List<PhotoData>) : CaptureState()

    /** An error occurred */
    data class Error(val message: String) : CaptureState()
}
