package com.jc.photobooth.ui.photobooth.sony

import androidx.compose.ui.graphics.ImageBitmap
import com.jc.photobooth.model.PhotoData

/**
 * Represents the state of the Sony photobooth capture sequence.
 *
 * Mark 1.1 workflow: Countdown → Freeze → Screenshot → Camera Capture → Repeat
 */
sealed class SonyCaptureState {
    /**
     * Initial state, ready to start capture sequence.
     */
    data object Idle : SonyCaptureState()

    /**
     * Countdown in progress before capturing a photo.
     *
     * @param remainingSeconds Seconds remaining in countdown (3...2...1)
     * @param photoIndex Current photo being captured (1-based)
     * @param totalPhotos Total number of photos in sequence
     */
    data class Countdown(
        val remainingSeconds: Int,
        val photoIndex: Int,
        val totalPhotos: Int
    ) : SonyCaptureState()

    /**
     * Photo being captured (screenshot taken, camera trigger in progress).
     *
     * @param photoIndex Current photo being captured (1-based)
     * @param frozenFrame The frozen live view frame that was screenshotted
     */
    data class Capturing(
        val photoIndex: Int,
        val frozenFrame: ImageBitmap
    ) : SonyCaptureState()

    /**
     * All photos captured successfully.
     *
     * @param photos List of captured screenshots (PhotoData with JPEG bytes)
     */
    data class Complete(
        val photos: List<PhotoData>
    ) : SonyCaptureState()

    /**
     * Error occurred during capture sequence.
     *
     * @param message Error description
     */
    data class Error(
        val message: String
    ) : SonyCaptureState()
}
