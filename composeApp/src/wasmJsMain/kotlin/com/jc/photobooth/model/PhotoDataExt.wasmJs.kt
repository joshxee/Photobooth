package com.jc.photobooth.model

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image

/**
 * WasmJS implementation to convert PhotoData to ImageBitmap.
 */
actual fun PhotoData.toImageBitmap(): ImageBitmap {
    return Image.makeFromEncoded(imageBytes).toComposeImageBitmap()
}
