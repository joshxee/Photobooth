package com.jc.photobooth.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class PhotoDataTest {

    @Test
    fun shouldCreatePhotoData() {
        val imageBytes = byteArrayOf(1, 2, 3, 4, 5)
        val timestamp = 123456789L

        val photoData = PhotoData(
            imageBytes = imageBytes,
            timestamp = timestamp
        )

        assertEquals(5, photoData.imageBytes.size)
        assertEquals(123456789L, photoData.timestamp)
    }

    @Test
    fun shouldHandleEmptyImageBytes() {
        val photoData = PhotoData(
            imageBytes = byteArrayOf(),
            timestamp = 0L
        )

        assertEquals(0, photoData.imageBytes.size)
        assertEquals(0L, photoData.timestamp)
    }

    @Test
    fun shouldComparePhotoDataByContent() {
        val imageBytes1 = byteArrayOf(1, 2, 3)
        val imageBytes2 = byteArrayOf(1, 2, 3)
        val imageBytes3 = byteArrayOf(4, 5, 6)

        val photo1 = PhotoData(imageBytes1, 100L)
        val photo2 = PhotoData(imageBytes2, 100L)
        val photo3 = PhotoData(imageBytes3, 100L)
        val photo4 = PhotoData(imageBytes1, 200L)

        assertEquals(photo1, photo2) // Same content
        assertNotEquals(photo1, photo3) // Different bytes
        assertNotEquals(photo1, photo4) // Different timestamp
    }

    @Test
    fun shouldGenerateConsistentHashCode() {
        val imageBytes1 = byteArrayOf(1, 2, 3)
        val imageBytes2 = byteArrayOf(1, 2, 3)

        val photo1 = PhotoData(imageBytes1, 100L)
        val photo2 = PhotoData(imageBytes2, 100L)

        assertEquals(photo1.hashCode(), photo2.hashCode())
    }

    @Test
    fun shouldStoreImageBytesCorrectly() {
        val originalBytes = byteArrayOf(10, 20, 30, 40, 50)
        val photoData = PhotoData(imageBytes = originalBytes, timestamp = 1000L)

        assertTrue(originalBytes.contentEquals(photoData.imageBytes))
    }
}
