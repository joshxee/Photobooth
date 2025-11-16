package com.jc.photobooth.model

import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

/**
 * Android implementation to convert PhotoData to ImageBitmap.
 */
actual fun PhotoData.toImageBitmap(): ImageBitmap {
    val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
    return bitmap.asImageBitmap()
}
