package com.jc.photobooth.util

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toAwtImage
import org.jetbrains.skia.EncodedImageFormat
import org.jetbrains.skia.Image
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

/**
 * JVM/Desktop implementation of image encoder using Skia and Java ImageIO.
 */
actual fun encodeImageBitmapToJpeg(imageBitmap: ImageBitmap, quality: Int): ByteArray {
    require(quality in 1..100) { "Quality must be between 1 and 100" }

    // Convert Compose ImageBitmap to AWT BufferedImage
    val bufferedImage = imageBitmap.toAwtImage()

    // Encode to JPEG using ImageIO
    val outputStream = ByteArrayOutputStream()
    val success = ImageIO.write(bufferedImage, "JPEG", outputStream)

    if (!success) {
        throw IllegalStateException("Failed to encode ImageBitmap to JPEG")
    }

    return outputStream.toByteArray()
}
