package com.jc.photobooth.util

import androidx.compose.ui.graphics.ImageBitmap

/**
 * Platform-specific image encoder for converting ImageBitmap to JPEG byte arrays.
 *
 * Used for capturing live view frames as screenshots in the Sony photobooth Mark 1.1 workflow.
 */
expect fun encodeImageBitmapToJpeg(imageBitmap: ImageBitmap, quality: Int = 90): ByteArray
