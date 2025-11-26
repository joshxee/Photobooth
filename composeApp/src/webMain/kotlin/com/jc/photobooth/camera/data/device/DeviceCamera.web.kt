package com.jc.photobooth.camera.data.device

import androidx.compose.ui.graphics.ImageBitmap
import com.jc.photobooth.camera.domain.CapturedPhoto
import com.jc.photobooth.camera.domain.ConnectionState
import com.jc.photobooth.camera.domain.PhotoboothCamera
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Web (JS/WASM) implementation of device camera.
 * TODO: Implement using WebRTC getUserMedia API
 */
actual class DeviceCamera : PhotoboothCamera {
    override val cameraId: String = "device_camera"
    override val displayName: String = "Device Camera"

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _liveViewFrame = MutableStateFlow<ImageBitmap?>(null)
    override val liveViewFrame: StateFlow<ImageBitmap?> = _liveViewFrame.asStateFlow()

    override suspend fun connect(): Result<Unit> {
        // TODO: Request getUserMedia permission
        _connectionState.value = ConnectionState.Connected
        return Result.success(Unit)
    }

    override suspend fun disconnect() {
        // TODO: Stop media stream
        _connectionState.value = ConnectionState.Disconnected
        _liveViewFrame.value = null
    }

    override suspend fun startLiveView(): Result<Unit> {
        // TODO: Start video stream from getUserMedia
        return Result.success(Unit)
    }

    override suspend fun stopLiveView() {
        // TODO: Stop video stream
        _liveViewFrame.value = null
    }

    override suspend fun capture(): Result<CapturedPhoto> {
        // TODO: Capture frame from video stream
        return Result.failure(Exception("Device camera not yet implemented"))
    }

    override suspend fun isAvailable(): Boolean {
        // TODO: Check if getUserMedia is available
        return true
    }
}
