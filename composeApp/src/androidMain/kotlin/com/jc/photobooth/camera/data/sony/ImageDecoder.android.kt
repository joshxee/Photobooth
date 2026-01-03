package com.jc.photobooth.camera.data.sony

import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

/**
 * Android implementation of image decoder using BitmapFactory.
 */
actual fun decodeImageBitmap(data: ByteArray): ImageBitmap {
    val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size)
        ?: throw IllegalArgumentException("Failed to decode image data")
    return bitmap.asImageBitmap()
}
