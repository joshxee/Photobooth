package com.jc.photobooth.camera.domain

/**
 * Supported camera types in the photobooth app
 */
enum class CameraType(val id: String, val displayName: String) {
    DEVICE_CAMERA("device_camera", "Device Camera"),
    SONY_A7III("sony_a7iii", "Sony A7 III");

    companion object {
        fun fromId(id: String): CameraType? {
            return entries.find { it.id == id }
        }
    }
}
