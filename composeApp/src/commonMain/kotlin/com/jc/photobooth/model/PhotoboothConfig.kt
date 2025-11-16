package com.jc.photobooth.model

/**
 * Configuration for photobooth capture settings.
 *
 * @property countdownSeconds Seconds to countdown before each photo (must be >= 1)
 * @property numberOfPhotos Number of photos to capture in sequence (must be >= 1)
 */
data class PhotoboothConfig(
    val countdownSeconds: Int = 3,
    val numberOfPhotos: Int = 3
) {
    init {
        require(countdownSeconds > 0) { "Countdown must be at least 1 second" }
        require(numberOfPhotos > 0) { "Must capture at least 1 photo" }
    }
}
