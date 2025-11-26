package com.jc.photobooth.camera.data.device

import androidx.compose.ui.graphics.ImageBitmap
import com.jc.photobooth.camera.domain.CapturedPhoto
import com.jc.photobooth.camera.domain.ConnectionState
import com.jc.photobooth.camera.domain.PhotoboothCamera
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * iOS implementation of device camera.
 * TODO: Implement using AVFoundation
 */
actual class DeviceCamera : PhotoboothCamera {
    override val cameraId: String = "device_camera"
    override val displayName: String = "Device Camera"

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _liveViewFrame = MutableStateFlow<ImageBitmap?>(null)
    override val liveViewFrame: StateFlow<ImageBitmap?> = _liveViewFrame.asStateFlow()

    override suspend fun connect(): Result<Unit> {
        // TODO: Initialize AVFoundation camera
        _connectionState.value = ConnectionState.Connected
        return Result.success(Unit)
    }

    override suspend fun disconnect() {
        // TODO: Release camera resources
        _connectionState.value = ConnectionState.Disconnected
        _liveViewFrame.value = null
    }

    override suspend fun startLiveView(): Result<Unit> {
        // TODO: Start AVFoundation preview
        return Result.success(Unit)
    }

    override suspend fun stopLiveView() {
        // TODO: Stop AVFoundation preview
        _liveViewFrame.value = null
    }

    override suspend fun capture(): Result<CapturedPhoto> {
        // TODO: Capture image using AVFoundation
        return Result.failure(Exception("Device camera not yet implemented"))
    }

    override suspend fun isAvailable(): Boolean {
        // TODO: Check if camera hardware is available
        return true
    }
}
