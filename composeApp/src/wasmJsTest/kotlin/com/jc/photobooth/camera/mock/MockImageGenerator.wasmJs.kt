package com.jc.photobooth.camera.mock

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image
import org.khronos.webgl.Uint8Array
import org.khronos.webgl.get
import org.w3c.dom.CanvasRenderingContext2D
import org.w3c.dom.HTMLCanvasElement
import kotlinx.browser.document

/**
 * WebAssembly implementation of MockImageGenerator using HTML5 Canvas.
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
        val canvas = createCanvas(width, height, photoIndex, style)
        val dataUrl = canvas.toDataURL("image/png")

        // Convert data URL to bytes
        val base64 = dataUrl.substringAfter("base64,")
        val bytes = base64ToByteArray(base64)

        // Convert to Skia Image and then to ImageBitmap
        return Image.makeFromEncoded(bytes).toComposeImageBitmap()
    }

    actual fun generateImageBytes(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): ByteArray {
        val canvas = createCanvas(width, height, photoIndex, style)
        val dataUrl = canvas.toDataURL("image/jpeg", 0.9)

        // Convert data URL to bytes
        val base64 = dataUrl.substringAfter("base64,")
        return base64ToByteArray(base64)
    }

    /**
     * Creates an HTML Canvas with colored background and text.
     */
    private fun createCanvas(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): HTMLCanvasElement {
        val canvas = document.createElement("canvas") as HTMLCanvasElement
        canvas.width = width
        canvas.height = height

        val ctx = canvas.getContext("2d") as CanvasRenderingContext2D

        // Draw background
        when (style) {
            MockImageStyle.SOLID_COLOR -> drawSolidColor(ctx, width, height, photoIndex)
            MockImageStyle.PATTERN -> drawCheckerboard(ctx, width, height, photoIndex)
        }

        // Draw text
        val text = "Photo $photoIndex"

        // Manually center the text
        ctx.font = "bold 48px Arial"
        val textWidth = ctx.measureText(text).width
        val x = (width - textWidth) / 2.0
        val y = height / 2.0

        // Draw shadow
        ctx.fillStyle = "black"
        ctx.fillText(text, x + 2, y + 2)

        // Draw text
        ctx.fillStyle = "white"
        ctx.fillText(text, x, y)

        return canvas
    }

    /**
     * Draws a solid color background.
     */
    private fun drawSolidColor(ctx: CanvasRenderingContext2D, width: Int, height: Int, photoIndex: Int) {
        ctx.fillStyle = when (photoIndex % 4) {
            0 -> "rgb(255, 0, 0)"      // Red
            1 -> "rgb(0, 200, 0)"      // Green
            2 -> "rgb(0, 0, 255)"      // Blue
            else -> "rgb(255, 200, 0)" // Orange
        }
        ctx.fillRect(0.0, 0.0, width.toDouble(), height.toDouble())
    }

    /**
     * Draws a checkerboard pattern.
     */
    private fun drawCheckerboard(ctx: CanvasRenderingContext2D, width: Int, height: Int, photoIndex: Int) {
        val squareSize = 50.0
        val color1 = when (photoIndex % 4) {
            0 -> "rgb(255, 0, 0)"      // Red
            1 -> "rgb(0, 200, 0)"      // Green
            2 -> "rgb(0, 0, 255)"      // Blue
            else -> "rgb(255, 200, 0)" // Orange
        }
        val color2 = "white"

        var y = 0.0
        while (y < height) {
            var x = 0.0
            while (x < width) {
                val isEvenRow = ((y / squareSize).toInt() % 2 == 0)
                val isEvenCol = ((x / squareSize).toInt() % 2 == 0)
                ctx.fillStyle = if (isEvenRow == isEvenCol) color1 else color2

                val rectWidth = squareSize.coerceAtMost(width.toDouble() - x)
                val rectHeight = squareSize.coerceAtMost(height.toDouble() - y)
                ctx.fillRect(x, y, rectWidth, rectHeight)

                x += squareSize
            }
            y += squareSize
        }
    }

    /**
     * Converts base64 string to ByteArray.
     */
    private fun base64ToByteArray(base64: String): ByteArray {
        val binaryString = js("atob")(base64) as String
        return ByteArray(binaryString.length) { i ->
            binaryString[i].code.toByte()
        }
    }
}
