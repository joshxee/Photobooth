package com.jc.photobooth.permissions

/**
 * Interface for handling camera permission requests across platforms.
 *
 * Platform-specific implementations should be provided via the expect/actual pattern.
 */
interface CameraPermissionHandler {
    /**
     * Check the current camera permission state without requesting it.
     *
     * @return The current permission state
     */
    fun checkPermission(): PermissionState

    /**
     * Request camera permission from the user.
     * This may trigger a system permission dialog.
     *
     * @return The resulting permission state after the request
     */
    fun requestPermission(): PermissionState

    /**
     * Open the system settings page where the user can manually grant permissions.
     * This is typically used when permission is permanently denied.
     */
    fun openSettings()
}

/**
 * Factory function to create a platform-specific CameraPermissionHandler.
 * This is an expect declaration that will be implemented differently on each platform.
 */
expect fun createCameraPermissionHandler(): CameraPermissionHandler
