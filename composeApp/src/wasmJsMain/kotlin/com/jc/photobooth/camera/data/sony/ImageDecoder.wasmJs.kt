package com.jc.photobooth.camera.data.sony

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image

/**
 * WasmJS implementation of image decoder using Skia.
 */
actual fun decodeImageBitmap(data: ByteArray): ImageBitmap {
    return Image.makeFromEncoded(data).toComposeImageBitmap()
}
