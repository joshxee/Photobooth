package com.jc.photobooth.ui.photobooth.sony.mark2

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Tests for SonyMark2ViewModel state management.
 *
 * Note: These tests verify state management logic only.
 * Camera connectivity and actual capture workflow are tested via integration tests.
 */
class SonyMark2ViewModelTest {

    @Test
    fun mark2CaptureState_idle_isCorrect() {
        val state = Mark2CaptureState.Idle
        assertTrue(state is Mark2CaptureState.Idle)
    }

    @Test
    fun mark2CaptureState_countdown_hasCorrectProperties() {
        val state = Mark2CaptureState.Countdown(
            remainingSeconds = 3,
            photoIndex = 1,
            totalPhotos = 4
        )

        assertTrue(state is Mark2CaptureState.Countdown)
        assertEquals(3, state.remainingSeconds)
        assertEquals(1, state.photoIndex)
        assertEquals(4, state.totalPhotos)
    }

    @Test
    fun mark2CaptureState_capturing_hasCorrectPhotoIndex() {
        val state = Mark2CaptureState.Capturing(photoIndex = 2)

        assertTrue(state is Mark2CaptureState.Capturing)
        assertEquals(2, state.photoIndex)
    }

    @Test
    fun mark2CaptureState_downloading_hasUrlAndIndex() {
        val testUrl = "http://192.168.122.1:8080/photo.jpg"
        val state = Mark2CaptureState.Downloading(
            photoIndex = 1,
            url = testUrl
        )

        assertTrue(state is Mark2CaptureState.Downloading)
        assertEquals(1, state.photoIndex)
        assertEquals(testUrl, state.url)
    }

    @Test
    fun mark2CaptureState_error_hasMessage() {
        val errorMessage = "Camera connection failed"
        val state = Mark2CaptureState.Error(errorMessage)

        assertTrue(state is Mark2CaptureState.Error)
        assertEquals(errorMessage, state.message)
    }

    @Test
    fun sonyMark2UiState_initialState_hasCorrectDefaults() {
        val state = SonyMark2UiState()

        assertEquals(null, state.liveViewFrame)
        assertEquals(Mark2CaptureState.Idle, state.captureState)
        assertEquals(false, state.isConnected)
        assertEquals(false, state.isLiveViewActive)
    }

    @Test
    fun sonyMark2UiState_copy_updatesOnlySpecifiedFields() {
        val initialState = SonyMark2UiState(
            isConnected = false,
            isLiveViewActive = false
        )

        val updatedState = initialState.copy(isConnected = true)

        assertEquals(true, updatedState.isConnected)
        assertEquals(false, updatedState.isLiveViewActive)
        assertEquals(Mark2CaptureState.Idle, updatedState.captureState)
    }
}
