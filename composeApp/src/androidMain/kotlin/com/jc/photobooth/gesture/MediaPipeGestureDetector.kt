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
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Android implementation of GestureDetector using MediaPipe.
 *
 * Runs in LIVE_STREAM mode for async, non-blocking frame processing.
 * Tracks up to 2 hands and selects the Open_Palm gesture with the largest
 * bounding box (closest to camera). Calculates hand bounding box from the
 * 21 hand landmarks with 10% padding.
 *
 * Periodically swaps the recognizer via AtomicReference when no Open_Palm is
 * active. This drops MediaPipe's internal hand tracks and forces fresh detection,
 * ensuring new people entering frame are picked up quickly.
 *
 * Thread safety: processFrame (live-view coroutine thread) and handleResult
 * (MediaPipe callback thread) run concurrently. AtomicReference.getAndSet is
 * used for the recognizer swap so the read-assign-close sequence is atomic.
 */
class MediaPipeGestureDetector(
    private val context: Context
) : GestureDetector {

    private val _results = MutableStateFlow<GestureResult?>(null)
    override val results: StateFlow<GestureResult?> = _results.asStateFlow()

    private val recognizerRef = AtomicReference(createRecognizer())
    private val lastResetTime = AtomicLong(System.currentTimeMillis())
    // Single background thread for all recognizer create/close ops — never blocks the callback thread
    private val resetExecutor = Executors.newSingleThreadExecutor()

    private fun createRecognizer(): GestureRecognizer {
        val baseOptions = BaseOptions.builder()
            .setModelAssetPath("gesture_recognizer.task")
            .build()

        val options = GestureRecognizer.GestureRecognizerOptions.builder()
            .setBaseOptions(baseOptions)
            .setRunningMode(com.google.mediapipe.tasks.vision.core.RunningMode.LIVE_STREAM)
            .setNumHands(2)
            .setMinHandDetectionConfidence(0.4f)
            .setMinHandPresenceConfidence(0.4f)
            .setMinTrackingConfidence(0.4f)
            .setResultListener(::handleResult)
            .setErrorListener { error ->
                android.util.Log.e(TAG, "MediaPipe error: ${error.message}", error)
            }
            .build()

        return GestureRecognizer.createFromOptions(context, options)
    }

    override fun processFrame(imageBytes: ByteArray, timestampMs: Long) {
        try {
            val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
                ?: return
            val mpImage = BitmapImageBuilder(bitmap).build()
            recognizerRef.get().recognizeAsync(mpImage, timestampMs)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Frame processing failed: ${e.message}")
        }
    }

    override fun close() {
        resetExecutor.shutdown()
        try {
            recognizerRef.get().close()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Error closing gesture recognizer: ${e.message}")
        }
    }

    private fun handleResult(result: GestureRecognizerResult, input: com.google.mediapipe.framework.image.MPImage) {
        val now = System.currentTimeMillis()

        if (result.gestures().isEmpty() || result.landmarks().isEmpty()) {
            _results.value = null
            maybeResetRecognizer(now)
            return
        }

        // Find the Open_Palm gesture with the largest bounding box
        // (assumes person closest to camera is the one posing)
        var bestGesture: com.google.mediapipe.tasks.components.containers.Category? = null
        var bestLandmarks: List<com.google.mediapipe.tasks.components.containers.NormalizedLandmark>? = null
        var largestArea = 0f

        for (i in result.gestures().indices) {
            val gesture = result.gestures()[i][0]
            if (gesture.categoryName() == OPEN_PALM_GESTURE) {
                val landmarks = result.landmarks()[i]
                val bbox = calculateBoundingBox(landmarks)
                val area = (bbox.right - bbox.left) * (bbox.bottom - bbox.top)

                if (area > largestArea) {
                    bestGesture = gesture
                    bestLandmarks = landmarks
                    largestArea = area
                }
            }
        }

        if (bestGesture == null || bestLandmarks == null) {
            // Hands visible but no Open_Palm — still eligible for reset
            _results.value = null
            maybeResetRecognizer(now)
            return
        }

        // Active palm — push reset timer forward so we don't interrupt mid-gesture
        lastResetTime.set(now)

        val boundingBox = calculateBoundingBox(bestLandmarks)
        _results.value = GestureResult(
            gestureName = bestGesture.categoryName(),
            confidence = bestGesture.score(),
            boundingBox = boundingBox
        )
    }

    private fun maybeResetRecognizer(now: Long) {
        if (now - lastResetTime.get() <= TRACKING_RESET_INTERVAL_MS) return
        // Mark reset time immediately to prevent re-entry from subsequent callback frames
        lastResetTime.set(now)
        // Offload to background executor — never block the MediaPipe callback thread.
        // close() acquires the native Graph lock; calling it on the callback thread
        // while the processing thread holds the same lock causes a deadlock → ANR.
        resetExecutor.submit {
            try {
                val new = createRecognizer()
                val old = recognizerRef.getAndSet(new)
                old.close()
                android.util.Log.d(TAG, "Recognizer reset — fresh hand detection")
            } catch (e: Exception) {
                android.util.Log.w(TAG, "Recognizer reset failed: ${e.message}")
            }
        }
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
        private const val TRACKING_RESET_INTERVAL_MS = 3000L
    }
}
