package com.jc.photobooth.camera.data.sony

import androidx.compose.ui.graphics.ImageBitmap

/**
 * Platform-specific image decoder for JPEG byte arrays.
 */
expect fun decodeImageBitmap(data: ByteArray): ImageBitmap
