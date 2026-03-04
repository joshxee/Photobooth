package com.jc.photobooth.ui.photobooth.sony.mark2

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for SonyMark2ViewModel state management.
 *
 * Note: These tests verify state management logic only.
 * Camera connectivity and actual capture workflow are tested via integration tests.
 */
class SonyMark2ViewModelTest {

    // ─────────────────────────────────────────────────────────────────────────
    // Mark2CaptureState
    // ─────────────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────────────
    // AutoReconnectState
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun autoReconnectState_idle_isCorrect() {
        val state = AutoReconnectState.Idle
        assertTrue(state is AutoReconnectState.Idle)
    }

    @Test
    fun autoReconnectState_inProgress_tracksAttemptNumber() {
        val state = AutoReconnectState.InProgress(attemptNumber = 3)

        assertTrue(state is AutoReconnectState.InProgress)
        assertEquals(3, state.attemptNumber)
    }

    @Test
    fun autoReconnectState_inProgress_attemptNumberIncrementsPerAttempt() {
        val firstAttempt = AutoReconnectState.InProgress(1)
        val secondAttempt = AutoReconnectState.InProgress(2)

        assertEquals(1, firstAttempt.attemptNumber)
        assertEquals(2, secondAttempt.attemptNumber)
        assertTrue(secondAttempt.attemptNumber > firstAttempt.attemptNumber)
    }

    @Test
    fun autoReconnectState_gaveUp_isCorrect() {
        val state = AutoReconnectState.GaveUp
        assertTrue(state is AutoReconnectState.GaveUp)
    }

    @Test
    fun autoReconnectState_equality_idleMatchesIdle() {
        assertEquals(AutoReconnectState.Idle, AutoReconnectState.Idle)
    }

    @Test
    fun autoReconnectState_equality_gaveUpMatchesGaveUp() {
        assertEquals(AutoReconnectState.GaveUp, AutoReconnectState.GaveUp)
    }

    @Test
    fun autoReconnectState_equality_inProgressWithSameAttemptMatches() {
        assertEquals(
            AutoReconnectState.InProgress(5),
            AutoReconnectState.InProgress(5)
        )
    }

    @Test
    fun autoReconnectState_equality_inProgressWithDifferentAttemptDiffers() {
        val a = AutoReconnectState.InProgress(1)
        val b = AutoReconnectState.InProgress(2)
        assertTrue(a != b)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SonyMark2UiState
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun sonyMark2UiState_initialState_hasCorrectDefaults() {
        val state = SonyMark2UiState()

        assertEquals(null, state.liveViewFrame)
        assertEquals(Mark2CaptureState.Idle, state.captureState)
        assertFalse(state.isConnected)
        assertFalse(state.isLiveViewActive)
        assertEquals(AutoReconnectState.Idle, state.autoReconnect)
    }

    @Test
    fun sonyMark2UiState_copy_updatesOnlySpecifiedFields() {
        val initialState = SonyMark2UiState(
            isConnected = false,
            isLiveViewActive = false
        )

        val updatedState = initialState.copy(isConnected = true)

        assertTrue(updatedState.isConnected)
        assertFalse(updatedState.isLiveViewActive)
        assertEquals(Mark2CaptureState.Idle, updatedState.captureState)
        assertEquals(AutoReconnectState.Idle, updatedState.autoReconnect)
    }

    @Test
    fun sonyMark2UiState_autoReconnect_canBeSetToInProgress() {
        val state = SonyMark2UiState().copy(
            autoReconnect = AutoReconnectState.InProgress(1)
        )

        assertTrue(state.autoReconnect is AutoReconnectState.InProgress)
        assertEquals(1, (state.autoReconnect as AutoReconnectState.InProgress).attemptNumber)
    }

    @Test
    fun sonyMark2UiState_autoReconnect_canBeSetToGaveUp() {
        val state = SonyMark2UiState().copy(
            autoReconnect = AutoReconnectState.GaveUp
        )

        assertTrue(state.autoReconnect is AutoReconnectState.GaveUp)
    }

    @Test
    fun sonyMark2UiState_reconnectCanBeReset_afterGaveUp() {
        val gaveUpState = SonyMark2UiState().copy(
            autoReconnect = AutoReconnectState.GaveUp
        )

        val resetState = gaveUpState.copy(autoReconnect = AutoReconnectState.Idle)

        assertEquals(AutoReconnectState.Idle, resetState.autoReconnect)
    }
}
