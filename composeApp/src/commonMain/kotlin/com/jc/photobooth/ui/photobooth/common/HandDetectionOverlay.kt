package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import com.jc.photobooth.gesture.HandBoundingBox

/**
 * Overlay that draws a white bounding box around a detected hand.
 *
 * Handles mirror-flipped live view by inverting x coordinates
 * when [isMirrored] is true.
 *
 * @param boundingBox Normalized bounding box (0-1) of the detected hand
 * @param isMirrored Whether the live view is horizontally flipped
 */
@Composable
fun HandDetectionOverlay(
    boundingBox: HandBoundingBox,
    isMirrored: Boolean,
    modifier: Modifier = Modifier
) {
    Canvas(modifier = modifier.fillMaxSize()) {
        val canvasWidth = size.width
        val canvasHeight = size.height

        val left: Float
        val right: Float
        if (isMirrored) {
            left = (1f - boundingBox.right) * canvasWidth
            right = (1f - boundingBox.left) * canvasWidth
        } else {
            left = boundingBox.left * canvasWidth
            right = boundingBox.right * canvasWidth
        }

        val top = boundingBox.top * canvasHeight
        val bottom = boundingBox.bottom * canvasHeight

        drawRect(
            color = Color.White,
            topLeft = Offset(left, top),
            size = Size(right - left, bottom - top),
            style = Stroke(width = 6f)
        )
    }
}
