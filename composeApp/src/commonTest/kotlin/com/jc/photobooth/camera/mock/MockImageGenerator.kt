package com.jc.photobooth.camera.mock

import androidx.compose.ui.graphics.ImageBitmap

/**
 * Generates mock test images programmatically.
 *
 * Creates simple images with colored backgrounds and text, avoiding
 * platform-specific graphics APIs.
 *
 * Uses expect/actual pattern so each platform can implement image
 * generation using its native APIs.
 */
expect object MockImageGenerator {

    /**
     * Generates an ImageBitmap for display in Compose UI.
     *
     * Creates a simple colored image with "Photo {photoIndex}" text.
     *
     * @param width Image width in pixels
     * @param height Image height in pixels
     * @param photoIndex Photo sequence number (affects color and text)
     * @param style Visual style (solid color or pattern)
     * @return Generated ImageBitmap
     */
    fun generateImageBitmap(
        width: Int = 640,
        height: Int = 480,
        photoIndex: Int = 0,
        style: MockImageStyle = MockImageStyle.SOLID_COLOR
    ): ImageBitmap

    /**
     * Generates image bytes (JPEG format) for storage or transmission.
     *
     * Creates a simple colored image with "Photo {photoIndex}" text.
     *
     * @param width Image width in pixels
     * @param height Image height in pixels
     * @param photoIndex Photo sequence number (affects color and text)
     * @param style Visual style (solid color or pattern)
     * @return JPEG-encoded byte array
     */
    fun generateImageBytes(
        width: Int = 640,
        height: Int = 480,
        photoIndex: Int = 0,
        style: MockImageStyle = MockImageStyle.SOLID_COLOR
    ): ByteArray
}
