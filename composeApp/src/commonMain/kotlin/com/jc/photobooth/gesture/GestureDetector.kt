package com.jc.photobooth.gesture

import kotlinx.coroutines.flow.StateFlow

/**
 * Normalized bounding box for a detected hand (values 0-1).
 */
data class HandBoundingBox(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float
)

/**
 * Result of gesture detection on a single frame.
 */
data class GestureResult(
    val gestureName: String,
    val confidence: Float,
    val boundingBox: HandBoundingBox
)

/**
 * Platform-agnostic gesture detector interface.
 *
 * Processes camera frames and emits gesture recognition results.
 * On Android, backed by MediaPipe. Other platforms return null from factory.
 */
interface GestureDetector {

    /**
     * Latest gesture detection result, or null if no gesture detected.
     */
    val results: StateFlow<GestureResult?>

    /**
     * Process a JPEG frame for gesture detection.
     *
     * @param imageBytes JPEG-encoded image data
     * @param timestampMs Frame timestamp in milliseconds
     */
    fun processFrame(imageBytes: ByteArray, timestampMs: Long)

    /**
     * Release resources held by the detector.
     */
    fun close()
}
