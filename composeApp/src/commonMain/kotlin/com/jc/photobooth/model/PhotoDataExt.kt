package com.jc.photobooth.model

import androidx.compose.ui.graphics.ImageBitmap

/**
 * Platform-specific conversion from PhotoData to ImageBitmap.
 */
expect fun PhotoData.toImageBitmap(): ImageBitmap
