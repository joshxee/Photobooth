package com.jc.photobooth.permissions

/**
 * JVM implementation of CameraPermissionHandler (Desktop).
 * On desktop, camera permissions are typically handled at the OS level.
 * This is a simplified implementation that assumes permission is granted.
 */
class JvmCameraPermissionHandler : CameraPermissionHandler {
    override fun checkPermission(): PermissionState = PermissionState.GRANTED

    override fun requestPermission(): PermissionState = PermissionState.GRANTED

    override fun openSettings() {
        // Desktop platforms don't typically have app-specific permission settings
    }
}

actual fun createCameraPermissionHandler(): CameraPermissionHandler {
    return JvmCameraPermissionHandler()
}
