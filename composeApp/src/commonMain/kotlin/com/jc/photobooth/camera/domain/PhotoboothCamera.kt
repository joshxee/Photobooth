package com.jc.photobooth.camera.domain

import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.flow.StateFlow

/**
 * Core interface for all camera implementations in the photobooth app.
 * Supports both device cameras and external cameras (like Sony A7 III).
 */
interface PhotoboothCamera {
    /**
     * Unique identifier for this camera type (e.g., "device_camera", "sony_a7iii")
     */
    val cameraId: String

    /**
     * Human-readable name for this camera
     */
    val displayName: String

    /**
     * Current connection state of the camera
     */
    val connectionState: StateFlow<ConnectionState>

    /**
     * Live view frame from the camera (null when live view is not active)
     */
    val liveViewFrame: StateFlow<ImageBitmap?>

    /**
     * Connect to the camera
     */
    suspend fun connect(): Result<Unit>

    /**
     * Disconnect from the camera
     */
    suspend fun disconnect()

    /**
     * Start live view streaming
     */
    suspend fun startLiveView(): Result<Unit>

    /**
     * Stop live view streaming
     */
    suspend fun stopLiveView()

    /**
     * Capture a photo and return the captured image
     */
    suspend fun capture(): Result<CapturedPhoto>

    /**
     * Check if this camera is currently available for use
     */
    suspend fun isAvailable(): Boolean
}

/**
 * Represents the connection state of a camera
 */
sealed class ConnectionState {
    data object Disconnected : ConnectionState()
    data object Connecting : ConnectionState()
    data object Connected : ConnectionState()
    data class Error(val message: String, val exception: Throwable? = null) : ConnectionState()
}

/**
 * Represents a captured photo from the camera
 */
data class CapturedPhoto(
    val image: ImageBitmap,
    val timestamp: Long = System.currentTimeMillis(),
    val metadata: PhotoMetadata = PhotoMetadata()
)

/**
 * Metadata about a captured photo
 */
data class PhotoMetadata(
    val width: Int = 0,
    val height: Int = 0,
    val cameraId: String = "",
    val format: String = "JPEG"
)
