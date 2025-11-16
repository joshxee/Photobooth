package com.jc.photobooth.ui.photobooth

import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.permissions.PermissionState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhotoboothUiStateTest {

    @Test
    fun defaultStateHasCorrectDefaults() {
        val state = PhotoboothUiState()
        assertEquals(PermissionState.NOT_DETERMINED, state.permissionState)
        assertTrue(state.captureState is CaptureState.Idle)
        assertEquals(3, state.config.countdownSeconds)
        assertEquals(3, state.config.numberOfPhotos)
        assertFalse(state.isPermissionRequested)
    }

    @Test
    fun stateCanBeCreatedWithCustomConfig() {
        val config = PhotoboothConfig(countdownSeconds = 5, numberOfPhotos = 4)
        val state = PhotoboothUiState(config = config)
        assertEquals(5, state.config.countdownSeconds)
        assertEquals(4, state.config.numberOfPhotos)
    }

    @Test
    fun stateCanBeCopiedWithNewPermissionState() {
        val state = PhotoboothUiState()
        val newState = state.copy(permissionState = PermissionState.GRANTED)
        assertEquals(PermissionState.GRANTED, newState.permissionState)
    }

    @Test
    fun stateCanBeCopiedWithNewCaptureState() {
        val state = PhotoboothUiState()
        val newState = state.copy(captureState = CaptureState.Capturing(1))
        assertTrue(newState.captureState is CaptureState.Capturing)
    }
}
