package com.jc.photobooth.camera.mock

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

/**
 * JVM/Desktop implementation of MockImageGenerator using Java2D.
 *
 * Creates simple images with colored backgrounds and text using BufferedImage.
 */
actual object MockImageGenerator {

    actual fun generateImageBitmap(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): ImageBitmap {
        val bufferedImage = createBufferedImage(width, height, photoIndex, style)

        // Convert BufferedImage to ImageBitmap via Skia
        val outputStream = ByteArrayOutputStream()
        ImageIO.write(bufferedImage, "PNG", outputStream)
        val imageBytes = outputStream.toByteArray()

        return Image.makeFromEncoded(imageBytes).toComposeImageBitmap()
    }

    actual fun generateImageBytes(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): ByteArray {
        val bufferedImage = createBufferedImage(width, height, photoIndex, style)

        // Encode to JPEG
        val outputStream = ByteArrayOutputStream()
        ImageIO.write(bufferedImage, "JPEG", outputStream)
        return outputStream.toByteArray()
    }

    /**
     * Creates a BufferedImage with colored background and text.
     */
    private fun createBufferedImage(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): BufferedImage {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val g = image.createGraphics()

        // Enable anti-aliasing for smoother text
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)

        // Draw background
        when (style) {
            MockImageStyle.SOLID_COLOR -> drawSolidColor(g, width, height, photoIndex)
            MockImageStyle.PATTERN -> drawCheckerboard(g, width, height, photoIndex)
        }

        // Draw text
        g.color = Color.WHITE
        g.font = Font("Arial", Font.BOLD, 48)
        val text = "Photo $photoIndex"
        val fontMetrics = g.fontMetrics
        val textWidth = fontMetrics.stringWidth(text)
        val textHeight = fontMetrics.height
        val x = (width - textWidth) / 2
        val y = (height + textHeight / 2) / 2

        // Draw shadow
        g.color = Color.BLACK
        g.drawString(text, x + 2, y + 2)

        // Draw text
        g.color = Color.WHITE
        g.drawString(text, x, y)

        g.dispose()
        return image
    }

    /**
     * Draws a solid color background.
     * Colors: Red (0) → Green (1) → Blue (2) → Yellow (3) → repeat
     */
    private fun drawSolidColor(g: java.awt.Graphics2D, width: Int, height: Int, photoIndex: Int) {
        g.color = when (photoIndex % 4) {
            0 -> Color(255, 0, 0)      // Red
            1 -> Color(0, 200, 0)      // Green
            2 -> Color(0, 0, 255)      // Blue
            else -> Color(255, 200, 0) // Orange/Yellow
        }
        g.fillRect(0, 0, width, height)
    }

    /**
     * Draws a checkerboard pattern.
     */
    private fun drawCheckerboard(g: java.awt.Graphics2D, width: Int, height: Int, photoIndex: Int) {
        val squareSize = 50
        val color1 = when (photoIndex % 4) {
            0 -> Color(255, 0, 0)      // Red
            1 -> Color(0, 200, 0)      // Green
            2 -> Color(0, 0, 255)      // Blue
            else -> Color(255, 200, 0) // Orange/Yellow
        }
        val color2 = Color.WHITE

        var y = 0
        while (y < height) {
            var x = 0
            while (x < width) {
                val isEvenRow = ((y / squareSize) % 2 == 0)
                val isEvenCol = ((x / squareSize) % 2 == 0)
                g.color = if (isEvenRow == isEvenCol) color1 else color2

                val rectWidth = squareSize.coerceAtMost(width - x)
                val rectHeight = squareSize.coerceAtMost(height - y)
                g.fillRect(x, y, rectWidth, rectHeight)

                x += squareSize
            }
            y += squareSize
        }
    }
}
