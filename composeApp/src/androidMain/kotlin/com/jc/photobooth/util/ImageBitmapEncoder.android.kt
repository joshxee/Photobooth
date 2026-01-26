package com.jc.photobooth.util

import android.graphics.Bitmap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import java.io.ByteArrayOutputStream

/**
 * Android implementation of image encoder using Bitmap.compress().
 */
actual fun encodeImageBitmapToJpeg(imageBitmap: ImageBitmap, quality: Int): ByteArray {
    require(quality in 1..100) { "Quality must be between 1 and 100" }

    val androidBitmap = imageBitmap.asAndroidBitmap()
    val outputStream = ByteArrayOutputStream()

    val success = androidBitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
    if (!success) {
        throw IllegalStateException("Failed to encode ImageBitmap to JPEG")
    }

    return outputStream.toByteArray()
}
