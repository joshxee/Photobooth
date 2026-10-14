package app.tauri.photoboothcamera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** A rectangle as fractions of a frame's width and height. */
data class FrameRegion(val x: Float, val y: Float, val w: Float, val h: Float) {
    val centerX get() = x + w / 2f
    val centerY get() = y + h / 2f
    val area get() = w * h

    fun contains(px: Float, py: Float) = px >= x && px <= x + w && py >= y && py <= y + h
}

/**
 * Finds an open palm in a JPEG with MediaPipe's gesture recognizer.
 *
 * Built to be eager, because a booth that does not notice a raised hand is worse than one that
 * sometimes starts early:
 * - It crops the frame to the guest's box plus a generous margin (a hand pushed at the camera is
 *   bigger than the box, and a hand cut off at the crop edge is not found), then accepts a palm
 *   only if its centre is inside the box. Up to four hands are looked at, so bystanders cannot
 *   crowd the hand in the box out.
 * - It runs in IMAGE mode: every frame is detected from scratch. Video modes track the hands
 *   they found earlier and stick to them, which is the "jumping between hands" that stopped
 *   the old app from starting.
 * - Any hand classified `Open_Palm` with its centre inside the box counts; the biggest one wins.
 * - Thresholds are low (0.3).
 *
 * Not thread-safe: call from one thread at a time (the plugin uses a single executor).
 */
class PalmFinder(private val context: Context) {
    private var recognizer: GestureRecognizer? = null

    private fun recognizer(): GestureRecognizer =
        recognizer ?: GestureRecognizer.createFromOptions(
            context,
            GestureRecognizer.GestureRecognizerOptions.builder()
                .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL).build())
                .setRunningMode(com.google.mediapipe.tasks.vision.core.RunningMode.IMAGE)
                .setNumHands(MAX_HANDS)
                .setMinHandDetectionConfidence(MIN_CONFIDENCE)
                .setMinHandPresenceConfidence(MIN_CONFIDENCE)
                .setMinTrackingConfidence(MIN_CONFIDENCE)
                .build(),
        ).also { recognizer = it }

    fun close() {
        runCatching { recognizer?.close() }
        recognizer = null
    }

    /** The open hand inside [within] (frame fractions), as a frame-fraction box, or null. */
    fun find(jpeg: ByteArray, within: FrameRegion): FrameRegion? {
        val started = SystemClock.elapsedRealtime()
        val frame = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return null
        try {
            val crop = cropRect(within, frame.width, frame.height)
            val cropped = Bitmap.createBitmap(frame, crop.left, crop.top, crop.width, crop.height)
            try {
                val seen = Seen()
                val palm = findInCrop(cropped, crop, frame.width, frame.height, within, seen)
                report(frame, cropped, crop, within, seen, palm, SystemClock.elapsedRealtime() - started)
                return palm
            } finally {
                if (cropped !== frame) cropped.recycle()
            }
        } finally {
            frame.recycle()
        }
    }

    /** What the recognizer made of one crop, for the log. */
    private class Seen {
        var hands = 0
        val notes = ArrayList<String>()
    }

    private fun findInCrop(
        cropped: Bitmap,
        crop: PixelRect,
        frameW: Int,
        frameH: Int,
        within: FrameRegion,
        seen: Seen,
    ): FrameRegion? {
        val result = recognizer().recognize(BitmapImageBuilder(cropped).build())
        seen.hands = result.landmarks().size
        var best: FrameRegion? = null
        for (i in result.landmarks().indices) {
            val landmarks = result.landmarks()[i]
            if (landmarks.size < LANDMARKS) continue
            val top = result.gestures().getOrNull(i)?.firstOrNull()
            val labelled = top?.categoryName() == OPEN_PALM
            val fingers = extendedFingers(landmarks, crop)
            seen.notes.add("${top?.categoryName()}:${"%.2f".format(top?.score() ?: 0f)} fingers=$fingers")
            // Only the classifier's own `Open_Palm`. (Also accepting any hand with 4+ fingers
            // extended started sessions from the back of a hand or a hand hanging at the side.
            // `fingers` is only logged, to see what the classifier is deciding.)
            if (!labelled) continue

            var minX = Float.MAX_VALUE
            var minY = Float.MAX_VALUE
            var maxX = -Float.MAX_VALUE
            var maxY = -Float.MAX_VALUE
            for (p in landmarks) {
                minX = min(minX, p.x())
                minY = min(minY, p.y())
                maxX = max(maxX, p.x())
                maxY = max(maxY, p.y())
            }
            // Crop fractions to frame fractions.
            val palm = FrameRegion(
                x = (crop.left + minX * crop.width) / frameW,
                y = (crop.top + minY * crop.height) / frameH,
                w = (maxX - minX) * crop.width / frameW,
                h = (maxY - minY) * crop.height / frameH,
            )
            if (!within.contains(palm.centerX, palm.centerY)) continue
            if (best == null || palm.area > best.area) best = palm
        }
        return best
    }

    /**
     * How many of the five fingers point away from the wrist (the thumb counts when its tip is
     * farther from the little finger's base than its knuckle is). Measured in pixels, because
     * the crop is not square.
     */
    private fun extendedFingers(
        l: List<com.google.mediapipe.tasks.components.containers.NormalizedLandmark>,
        crop: PixelRect,
    ): Int {
        fun dist(a: Int, b: Int): Float {
            val dx = (l[a].x() - l[b].x()) * crop.width
            val dy = (l[a].y() - l[b].y()) * crop.height
            return sqrt(dx * dx + dy * dy)
        }
        var n = 0
        // Index, middle, ring, little: tip vs the middle joint, measured from the wrist.
        for ((tip, pip) in listOf(8 to 6, 12 to 10, 16 to 14, 20 to 18)) {
            if (dist(0, tip) > dist(0, pip) * FINGER_RATIO) n++
        }
        if (dist(4, 17) > dist(3, 17)) n++
        return n
    }

    private var lastReport = 0L
    private var calls = 0
    private var withHands = 0
    private var palms = 0

    /** One log line a second; with the `debug-gesture` flag file, also the frame and crop. */
    private fun report(
        frame: Bitmap,
        cropped: Bitmap,
        crop: PixelRect,
        within: FrameRegion,
        seen: Seen,
        palm: FrameRegion?,
        tookMs: Long,
    ) {
        calls++
        if (seen.hands > 0) withHands++
        if (palm != null) palms++
        val now = SystemClock.elapsedRealtime()
        if (now - lastReport < REPORT_EVERY_MS) return
        lastReport = now
        Log.d(
            TAG,
            "gesture: last second calls=$calls withHands=$withHands palms=$palms | frame=${frame.width}x${frame.height} box=" +
                "(%.2f,%.2f %.2fx%.2f) crop=${crop.left},${crop.top} ${crop.width}x${crop.height} ".format(
                    within.x, within.y, within.w, within.h,
                ) +
                "hands=${seen.hands} ${seen.notes} -> ${if (palm != null) "PALM" else "none"} ${tookMs}ms",
        )
        calls = 0
        withHands = 0
        palms = 0
        if (!debugDir.exists()) return
        runCatching {
            java.io.FileOutputStream(java.io.File(debugDir, "frame.jpg")).use {
                frame.compress(Bitmap.CompressFormat.JPEG, 85, it)
            }
            java.io.FileOutputStream(java.io.File(debugDir, "crop.jpg")).use {
                cropped.compress(Bitmap.CompressFormat.JPEG, 90, it)
            }
        }
    }

    /** Create this directory (`adb shell run-as <pkg> mkdir cache/gesture-debug`) to keep the last frame and crop. */
    private val debugDir = java.io.File(context.cacheDir, "gesture-debug")

    private class PixelRect(val left: Int, val top: Int, val width: Int, val height: Int)

    /** [within] grown by [CROP_MARGIN], in pixels, always at least a few pixels wide. */
    private fun cropRect(within: FrameRegion, frameW: Int, frameH: Int): PixelRect {
        val dx = within.w * CROP_MARGIN
        val dy = within.h * CROP_MARGIN
        val left = ((within.x - dx) * frameW).toInt().coerceIn(0, frameW - 2)
        val top = ((within.y - dy) * frameH).toInt().coerceIn(0, frameH - 2)
        val right = ((within.x + within.w + dx) * frameW).toInt().coerceIn(left + 2, frameW)
        val bottom = ((within.y + within.h + dy) * frameH).toInt().coerceIn(top + 2, frameH)
        return PixelRect(left, top, right - left, bottom - top)
    }

    companion object {
        private const val MODEL = "gesture_recognizer.task"
        private const val TAG = "PhotoboothCamera"
        private const val OPEN_PALM = "Open_Palm"
        private const val LANDMARKS = 21
        private const val FINGER_RATIO = 1.15f
        private const val REPORT_EVERY_MS = 1000L
        private const val MAX_HANDS = 4
        private const val MIN_CONFIDENCE = 0.3f
        private const val CROP_MARGIN = 0.5f
    }
}
