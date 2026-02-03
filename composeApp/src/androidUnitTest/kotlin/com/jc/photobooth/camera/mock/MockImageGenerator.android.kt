package com.jc.photobooth.camera.mock

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import java.io.ByteArrayOutputStream

/**
 * Android implementation of MockImageGenerator using Android Canvas/Bitmap.
 *
 * Creates simple images with colored backgrounds and text.
 */
actual object MockImageGenerator {

    actual fun generateImageBitmap(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): ImageBitmap {
        val bitmap = createBitmap(width, height, photoIndex, style)
        return bitmap.asImageBitmap()
    }

    actual fun generateImageBytes(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): ByteArray {
        val bitmap = createBitmap(width, height, photoIndex, style)

        // Encode to JPEG
        val outputStream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 90, outputStream)
        return outputStream.toByteArray()
    }

    /**
     * Creates an Android Bitmap with colored background and text.
     */
    private fun createBitmap(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)

        // Draw background
        when (style) {
            MockImageStyle.SOLID_COLOR -> drawSolidColor(canvas, width, height, photoIndex)
            MockImageStyle.PATTERN -> drawCheckerboard(canvas, width, height, photoIndex)
        }

        // Draw text
        val paint = Paint().apply {
            color = Color.WHITE
            textSize = 48f * (height / 480f) // Scale text based on height
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
            isFakeBoldText = true
        }

        val text = "Photo $photoIndex"
        val textBounds = Rect()
        paint.getTextBounds(text, 0, text.length, textBounds)

        val x = width / 2f
        val y = (height / 2f) + (textBounds.height() / 2f)

        // Draw shadow
        paint.color = Color.BLACK
        canvas.drawText(text, x + 2, y + 2, paint)

        // Draw text
        paint.color = Color.WHITE
        canvas.drawText(text, x, y, paint)

        return bitmap
    }

    /**
     * Draws a solid color background.
     * Colors: Red (0) → Green (1) → Blue (2) → Orange (3) → repeat
     */
    private fun drawSolidColor(canvas: Canvas, width: Int, height: Int, photoIndex: Int) {
        val paint = Paint()
        paint.color = when (photoIndex % 4) {
            0 -> Color.rgb(255, 0, 0)      // Red
            1 -> Color.rgb(0, 200, 0)      // Green
            2 -> Color.rgb(0, 0, 255)      // Blue
            else -> Color.rgb(255, 200, 0) // Orange
        }
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }

    /**
     * Draws a checkerboard pattern.
     */
    private fun drawCheckerboard(canvas: Canvas, width: Int, height: Int, photoIndex: Int) {
        val squareSize = 50f
        val color1 = when (photoIndex % 4) {
            0 -> Color.rgb(255, 0, 0)      // Red
            1 -> Color.rgb(0, 200, 0)      // Green
            2 -> Color.rgb(0, 0, 255)      // Blue
            else -> Color.rgb(255, 200, 0) // Orange
        }
        val color2 = Color.WHITE

        val paint = Paint()

        var y = 0f
        while (y < height) {
            var x = 0f
            while (x < width) {
                val isEvenRow = ((y / squareSize).toInt() % 2 == 0)
                val isEvenCol = ((x / squareSize).toInt() % 2 == 0)
                paint.color = if (isEvenRow == isEvenCol) color1 else color2

                val rectWidth = squareSize.coerceAtMost(width.toFloat() - x)
                val rectHeight = squareSize.coerceAtMost(height.toFloat() - y)
                canvas.drawRect(x, y, x + rectWidth, y + rectHeight, paint)

                x += squareSize
            }
            y += squareSize
        }
    }
}
