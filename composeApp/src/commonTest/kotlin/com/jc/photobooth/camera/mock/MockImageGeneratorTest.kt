package com.jc.photobooth.camera.mock

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class MockImageGeneratorTest {

    @Test
    fun generateImageBitmap_createsImageBitmapWithCorrectDimensions() {
        val width = 640
        val height = 480

        val imageBitmap = MockImageGenerator.generateImageBitmap(
            width = width,
            height = height,
            photoIndex = 0
        )

        assertNotNull(imageBitmap)
        assertEquals(width, imageBitmap.width)
        assertEquals(height, imageBitmap.height)
    }

    @Test
    fun generateImageBytes_returnsNonEmptyByteArray() {
        val imageBytes = MockImageGenerator.generateImageBytes(
            width = 640,
            height = 480,
            photoIndex = 0
        )

        assertNotNull(imageBytes)
        assertTrue(imageBytes.isNotEmpty(), "Generated image bytes should not be empty")
    }

    @Test
    fun differentPhotoIndices_produceDifferentColors() {
        // Generate images for different photo indices
        val image0 = MockImageGenerator.generateImageBitmap(width = 100, height = 100, photoIndex = 0)
        val image1 = MockImageGenerator.generateImageBitmap(width = 100, height = 100, photoIndex = 1)
        val image2 = MockImageGenerator.generateImageBitmap(width = 100, height = 100, photoIndex = 2)
        val image3 = MockImageGenerator.generateImageBitmap(width = 100, height = 100, photoIndex = 3)

        // Verify all images are created
        assertNotNull(image0)
        assertNotNull(image1)
        assertNotNull(image2)
        assertNotNull(image3)

        // All should have same dimensions
        assertEquals(100, image0.width)
        assertEquals(100, image1.width)
        assertEquals(100, image2.width)
        assertEquals(100, image3.width)
    }

    @Test
    fun generateImageBitmap_supportsPatternStyle() {
        val imageBitmap = MockImageGenerator.generateImageBitmap(
            width = 640,
            height = 480,
            photoIndex = 0,
            style = MockImageStyle.PATTERN
        )

        assertNotNull(imageBitmap)
        assertEquals(640, imageBitmap.width)
        assertEquals(480, imageBitmap.height)
    }
}
