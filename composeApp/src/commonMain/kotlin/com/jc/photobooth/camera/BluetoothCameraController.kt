package com.jc.photobooth.camera

import kotlinx.coroutines.flow.StateFlow

/**
 * Sealed class representing the state of a Bluetooth camera connection.
 */
sealed class BluetoothCameraState {
    /** Camera is not connected */
    data object Disconnected : BluetoothCameraState()

    /** Attempting to connect to camera */
    data object Connecting : BluetoothCameraState()

    /** Camera is connected and ready */
    data class Connected(val deviceName: String) : BluetoothCameraState()

    /** Camera is connected but remote control is disabled in camera settings */
    data object RemoteDisabled : BluetoothCameraState()

    /** Camera is not bonded/paired */
    data object NotPaired : BluetoothCameraState()

    /** Error occurred */
    data class Error(val message: String, val exception: Throwable? = null) : BluetoothCameraState()
}

/**
 * Status feedback from camera operations.
 */
data class BluetoothCameraStatus(
    val focusAcquired: Boolean = false,
    val shutterReady: Boolean = false,
    val recording: Boolean = false
)

/**
 * Interface for controlling Sony cameras via Bluetooth Low Energy (BLE).
 *
 * This uses Sony's proprietary Bluetooth remote control protocol to trigger
 * camera operations like shutter, focus, and recording.
 *
 * Supported cameras include:
 * - Sony α7 III, α7 IV, α7R III, α7R IV
 * - Sony α6400, α6600, α6700
 * - Sony α9, ZV-E10
 * - And other Sony cameras with Bluetooth remote support
 *
 * Note: The camera must have Bluetooth remote control enabled in its settings.
 * The protocol only supports button press commands - it cannot change camera
 * settings (ISO, aperture, shutter speed) or transfer images.
 */
interface BluetoothCameraController {
    /**
     * Flow of current camera connection state.
     */
    val cameraState: StateFlow<BluetoothCameraState>

    /**
     * Flow of camera status feedback.
     */
    val cameraStatus: StateFlow<BluetoothCameraStatus>

    /**
     * Start scanning for available cameras.
     * On Android, this may trigger permission requests if not already granted.
     */
    suspend fun startScanning()

    /**
     * Stop scanning for cameras.
     */
    fun stopScanning()

    /**
     * Connect to a camera by its Bluetooth address.
     *
     * @param address The Bluetooth MAC address of the camera
     */
    suspend fun connect(address: String)

    /**
     * Disconnect from the current camera.
     */
    fun disconnect()

    /**
     * Trigger the camera shutter.
     * This performs a full shutter sequence: half-press (focus) -> full press -> release.
     *
     * @param waitForFocus If true, waits for focus confirmation before triggering shutter
     */
    suspend fun triggerShutter(waitForFocus: Boolean = false)

    /**
     * Press the shutter button (without releasing).
     * Use this for manual control of the shutter sequence.
     *
     * @param halfPress If true, only half-press (focus), otherwise full press
     */
    suspend fun pressShutter(halfPress: Boolean = false)

    /**
     * Release the shutter button.
     *
     * @param halfPress If true, release to half-press state, otherwise fully release
     */
    suspend fun releaseShutter(halfPress: Boolean = false)

    /**
     * Start/stop video recording (toggle).
     */
    suspend fun toggleRecording()

    /**
     * Trigger autofocus (AF-ON button).
     */
    suspend fun triggerAutofocus()

    /**
     * Release all resources and disconnect.
     */
    fun release()
}

/**
 * Factory function to create a platform-specific BluetoothCameraController.
 * This is an expect declaration that will be implemented differently on each platform.
 */
expect fun createBluetoothCameraController(): BluetoothCameraController
