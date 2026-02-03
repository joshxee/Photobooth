package com.jc.photobooth.camera.mock

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image
import kotlinx.cinterop.*
import platform.CoreGraphics.*
import platform.UIKit.*
import platform.Foundation.*

/**
 * iOS implementation of MockImageGenerator using Core Graphics/UIKit.
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
        val image = createUIImage(width, height, photoIndex, style)
        val imageData = UIImagePNGRepresentation(image)
            ?: throw IllegalStateException("Failed to encode image to PNG")

        val bytes = imageData.toByteArray()
        return Image.makeFromEncoded(bytes).toComposeImageBitmap()
    }

    actual fun generateImageBytes(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): ByteArray {
        val image = createUIImage(width, height, photoIndex, style)
        val imageData = UIImageJPEGRepresentation(image, 0.9)
            ?: throw IllegalStateException("Failed to encode image to JPEG")

        return imageData.toByteArray()
    }

    /**
     * Creates a UIImage with colored background and text.
     */
    private fun createUIImage(
        width: Int,
        height: Int,
        photoIndex: Int,
        style: MockImageStyle
    ): UIImage {
        val size = CGSizeMake(width.toDouble(), height.toDouble())
        UIGraphicsBeginImageContextWithOptions(size, true, 1.0)

        val context = UIGraphicsGetCurrentContext()
            ?: throw IllegalStateException("Failed to get graphics context")

        // Draw background
        when (style) {
            MockImageStyle.SOLID_COLOR -> drawSolidColor(context, width, height, photoIndex)
            MockImageStyle.PATTERN -> drawCheckerboard(context, width, height, photoIndex)
        }

        // Draw text
        val text = "Photo $photoIndex" as NSString
        val attributes = mapOf<Any?, Any?>(
            NSFontAttributeName to UIFont.boldSystemFontOfSize(48.0),
            NSForegroundColorAttributeName to UIColor.whiteColor
        )

        val textSize = text.sizeWithAttributes(attributes)
        val textX = (width - textSize.useContents { width }) / 2.0
        val textY = (height - textSize.useContents { height }) / 2.0

        // Draw shadow
        val shadowAttributes = mapOf<Any?, Any?>(
            NSFontAttributeName to UIFont.boldSystemFontOfSize(48.0),
            NSForegroundColorAttributeName to UIColor.blackColor
        )
        text.drawAtPoint(CGPointMake(textX + 2, textY + 2), shadowAttributes)

        // Draw text
        text.drawAtPoint(CGPointMake(textX, textY), attributes)

        val image = UIGraphicsGetImageFromCurrentImageContext()
            ?: throw IllegalStateException("Failed to create image from context")

        UIGraphicsEndImageContext()
        return image
    }

    /**
     * Draws a solid color background.
     */
    private fun drawSolidColor(context: CGContextRef, width: Int, height: Int, photoIndex: Int) {
        val color = when (photoIndex % 4) {
            0 -> UIColor.colorWithRed(1.0, 0.0, 0.0, 1.0)        // Red
            1 -> UIColor.colorWithRed(0.0, 0.78, 0.0, 1.0)       // Green
            2 -> UIColor.colorWithRed(0.0, 0.0, 1.0, 1.0)        // Blue
            else -> UIColor.colorWithRed(1.0, 0.78, 0.0, 1.0)    // Orange
        }

        CGContextSetFillColorWithColor(context, color.CGColor)
        CGContextFillRect(context, CGRectMake(0.0, 0.0, width.toDouble(), height.toDouble()))
    }

    /**
     * Draws a checkerboard pattern.
     */
    private fun drawCheckerboard(context: CGContextRef, width: Int, height: Int, photoIndex: Int) {
        val squareSize = 50.0
        val color1 = when (photoIndex % 4) {
            0 -> UIColor.colorWithRed(1.0, 0.0, 0.0, 1.0)        // Red
            1 -> UIColor.colorWithRed(0.0, 0.78, 0.0, 1.0)       // Green
            2 -> UIColor.colorWithRed(0.0, 0.0, 1.0, 1.0)        // Blue
            else -> UIColor.colorWithRed(1.0, 0.78, 0.0, 1.0)    // Orange
        }
        val color2 = UIColor.whiteColor

        var y = 0.0
        while (y < height) {
            var x = 0.0
            while (x < width) {
                val isEvenRow = ((y / squareSize).toInt() % 2 == 0)
                val isEvenCol = ((x / squareSize).toInt() % 2 == 0)
                val color = if (isEvenRow == isEvenCol) color1 else color2

                CGContextSetFillColorWithColor(context, color.CGColor)

                val rectWidth = squareSize.coerceAtMost(width.toDouble() - x)
                val rectHeight = squareSize.coerceAtMost(height.toDouble() - y)
                CGContextFillRect(context, CGRectMake(x, y, rectWidth, rectHeight))

                x += squareSize
            }
            y += squareSize
        }
    }

    /**
     * Converts NSData to ByteArray.
     */
    private fun NSData.toByteArray(): ByteArray {
        return ByteArray(length.toInt()).apply {
            usePinned {
                memcpy(it.addressOf(0), bytes, length)
            }
        }
    }
}
