package com.jc.photobooth.ui.photobooth

import com.jc.photobooth.model.PhotoData
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CaptureStateTest {

    @Test
    fun idleStateExists() {
        val state = CaptureState.Idle
        assertTrue(state is CaptureState.Idle)
    }

    @Test
    fun countdownStateStoresCorrectValues() {
        val state = CaptureState.Countdown(
            remainingSeconds = 3,
            photoIndex = 1,
            totalPhotos = 3
        )
        assertEquals(3, state.remainingSeconds)
        assertEquals(1, state.photoIndex)
        assertEquals(3, state.totalPhotos)
    }

    @Test
    fun capturingStateStoresPhotoIndex() {
        val state = CaptureState.Capturing(photoIndex = 2)
        assertEquals(2, state.photoIndex)
    }

    @Test
    fun completeStateStoresPhotosList() {
        val photos = listOf(
            PhotoData(byteArrayOf(1), 100L),
            PhotoData(byteArrayOf(2), 200L)
        )
        val state = CaptureState.Complete(photos)
        assertEquals(2, state.photos.size)
    }

    @Test
    fun errorStateStoresErrorMessage() {
        val state = CaptureState.Error("Test error")
        assertEquals("Test error", state.message)
    }

    @Test
    fun sealedClassHasAllExpectedSubtypes() {
        // Verify exhaustiveness
        val states = listOf(
            CaptureState.Idle,
            CaptureState.Countdown(1, 1, 1),
            CaptureState.Capturing(1),
            CaptureState.Complete(emptyList()),
            CaptureState.Error("")
        )
        assertEquals(5, states.size)
    }
}
