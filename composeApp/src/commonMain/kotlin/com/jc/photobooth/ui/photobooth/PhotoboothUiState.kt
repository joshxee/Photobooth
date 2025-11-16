package com.jc.photobooth.ui.photobooth

import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.permissions.PermissionState

/**
 * UI state for the photobooth screen.
 */
data class PhotoboothUiState(
    val permissionState: PermissionState = PermissionState.NOT_DETERMINED,
    val captureState: CaptureState = CaptureState.Idle,
    val config: PhotoboothConfig = PhotoboothConfig(),
    val isPermissionRequested: Boolean = false
)
