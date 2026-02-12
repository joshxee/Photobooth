package com.jc.photobooth.gesture

import android.content.Context
import android.graphics.BitmapFactory
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizerResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Android implementation of GestureDetector using MediaPipe.
 *
 * Runs in LIVE_STREAM mode for async, non-blocking frame processing.
 * Filters for Open_Palm gesture only and calculates hand bounding box
 * from the 21 hand landmarks with 10% padding.
 */
class MediaPipeGestureDetector(
    context: Context
) : GestureDetector {

    private val _results = MutableStateFlow<GestureResult?>(null)
    override val results: StateFlow<GestureResult?> = _results.asStateFlow()

    private val gestureRecognizer: GestureRecognizer

    init {
        val baseOptions = BaseOptions.builder()
            .setModelAssetPath("gesture_recognizer.task")
            .build()

        val options = GestureRecognizer.GestureRecognizerOptions.builder()
            .setBaseOptions(baseOptions)
            .setRunningMode(com.google.mediapipe.tasks.vision.core.RunningMode.LIVE_STREAM)
            .setNumHands(1)
            .setMinHandDetectionConfidence(0.5f)
            .setMinHandPresenceConfidence(0.5f)
            .setMinTrackingConfidence(0.5f)
            .setResultListener(::handleResult)
            .setErrorListener { error ->
                android.util.Log.e(TAG, "MediaPipe error: ${error.message}", error)
            }
            .build()

        gestureRecognizer = GestureRecognizer.createFromOptions(context, options)
    }

    override fun processFrame(imageBytes: ByteArray, timestampMs: Long) {
        try {
            val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
                ?: return
            val mpImage = BitmapImageBuilder(bitmap).build()
            gestureRecognizer.recognizeAsync(mpImage, timestampMs)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Frame processing failed: ${e.message}")
        }
    }

    override fun close() {
        try {
            gestureRecognizer.close()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Error closing gesture recognizer: ${e.message}")
        }
    }

    private fun handleResult(result: GestureRecognizerResult, input: com.google.mediapipe.framework.image.MPImage) {
        if (result.gestures().isEmpty() || result.landmarks().isEmpty()) {
            _results.value = null
            return
        }

        val gesture = result.gestures()[0][0]
        if (gesture.categoryName() != OPEN_PALM_GESTURE) {
            _results.value = null
            return
        }

        val landmarks = result.landmarks()[0]
        val boundingBox = calculateBoundingBox(landmarks)

        _results.value = GestureResult(
            gestureName = gesture.categoryName(),
            confidence = gesture.score(),
            boundingBox = boundingBox
        )
    }

    private fun calculateBoundingBox(
        landmarks: List<com.google.mediapipe.tasks.components.containers.NormalizedLandmark>
    ): HandBoundingBox {
        var minX = Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxX = Float.MIN_VALUE
        var maxY = Float.MIN_VALUE

        for (landmark in landmarks) {
            if (landmark.x() < minX) minX = landmark.x()
            if (landmark.y() < minY) minY = landmark.y()
            if (landmark.x() > maxX) maxX = landmark.x()
            if (landmark.y() > maxY) maxY = landmark.y()
        }

        // Add 10% padding
        val width = maxX - minX
        val height = maxY - minY
        val paddingX = width * BOUNDING_BOX_PADDING
        val paddingY = height * BOUNDING_BOX_PADDING

        return HandBoundingBox(
            left = (minX - paddingX).coerceIn(0f, 1f),
            top = (minY - paddingY).coerceIn(0f, 1f),
            right = (maxX + paddingX).coerceIn(0f, 1f),
            bottom = (maxY + paddingY).coerceIn(0f, 1f)
        )
    }

    companion object {
        private const val TAG = "MediaPipeGesture"
        private const val OPEN_PALM_GESTURE = "Open_Palm"
        private const val BOUNDING_BOX_PADDING = 0.1f
    }
}
