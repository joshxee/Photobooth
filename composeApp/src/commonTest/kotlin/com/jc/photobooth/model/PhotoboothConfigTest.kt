package com.jc.photobooth.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PhotoboothConfigTest {

    @Test
    fun shouldHaveDefaultCountdownLength() {
        val config = PhotoboothConfig()
        assertEquals(3, config.countdownSeconds)
    }

    @Test
    fun shouldHaveDefaultPhotoCount() {
        val config = PhotoboothConfig()
        assertEquals(3, config.numberOfPhotos)
    }

    @Test
    fun shouldAllowCustomConfiguration() {
        val config = PhotoboothConfig(countdownSeconds = 5, numberOfPhotos = 4)
        assertEquals(5, config.countdownSeconds)
        assertEquals(4, config.numberOfPhotos)
    }

    @Test
    fun shouldValidateMinimumCountdown() {
        assertFailsWith<IllegalArgumentException> {
            PhotoboothConfig(countdownSeconds = 0)
        }
    }

    @Test
    fun shouldValidateNegativeCountdown() {
        assertFailsWith<IllegalArgumentException> {
            PhotoboothConfig(countdownSeconds = -1)
        }
    }

    @Test
    fun shouldValidateMinimumPhotoCount() {
        assertFailsWith<IllegalArgumentException> {
            PhotoboothConfig(numberOfPhotos = 0)
        }
    }

    @Test
    fun shouldValidateNegativePhotoCount() {
        assertFailsWith<IllegalArgumentException> {
            PhotoboothConfig(numberOfPhotos = -1)
        }
    }

    @Test
    fun shouldAllowOneSecondCountdown() {
        val config = PhotoboothConfig(countdownSeconds = 1)
        assertEquals(1, config.countdownSeconds)
    }

    @Test
    fun shouldAllowOnePhoto() {
        val config = PhotoboothConfig(numberOfPhotos = 1)
        assertEquals(1, config.numberOfPhotos)
    }
}
