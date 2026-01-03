package com.jc.photobooth.camera.data.device

import androidx.compose.ui.graphics.ImageBitmap
import com.jc.photobooth.camera.domain.CapturedPhoto
import com.jc.photobooth.camera.domain.ConnectionState
import com.jc.photobooth.camera.domain.PhotoboothCamera
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Platform-specific device camera implementation.
 * Uses expect/actual pattern for platform-specific camera APIs.
 */
expect class DeviceCamera() : PhotoboothCamera {
    override val cameraId: String
    override val displayName: String
    override val connectionState: StateFlow<ConnectionState>
    override val liveViewFrame: StateFlow<ImageBitmap?>

    override suspend fun connect(): Result<Unit>
    override suspend fun disconnect()
    override suspend fun startLiveView(): Result<Unit>
    override suspend fun stopLiveView()
    override suspend fun capture(): Result<CapturedPhoto>
    override suspend fun isAvailable(): Boolean
}
