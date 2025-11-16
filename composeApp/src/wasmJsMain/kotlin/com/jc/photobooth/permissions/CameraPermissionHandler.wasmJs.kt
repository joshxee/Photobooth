package com.jc.photobooth.permissions

/**
 * WasmJS implementation of CameraPermissionHandler (Web/Wasm).
 * Browser-based camera access uses the MediaDevices API which handles permissions differently.
 * This is a placeholder implementation.
 */
class WasmJsCameraPermissionHandler : CameraPermissionHandler {
    override fun checkPermission(): PermissionState = PermissionState.NOT_DETERMINED

    override fun requestPermission(): PermissionState = PermissionState.NOT_DETERMINED

    override fun openSettings() {
        // Browsers don't have app-specific permission settings
    }
}

actual fun createCameraPermissionHandler(): CameraPermissionHandler {
    return WasmJsCameraPermissionHandler()
}
