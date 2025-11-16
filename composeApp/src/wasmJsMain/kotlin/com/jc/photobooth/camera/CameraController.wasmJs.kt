package com.jc.photobooth.camera

import com.jc.photobooth.model.PhotoData

class WasmJsCameraController : CameraController {
    override fun startPreview() {}
    override fun stopPreview() {}
    override suspend fun capturePhoto(): PhotoData = PhotoData(byteArrayOf(1, 2, 3), kotlinx.datetime.Clock.System.now().toEpochMilliseconds())
    override fun release() {}
}

actual fun createCameraController(): CameraController = WasmJsCameraController()
