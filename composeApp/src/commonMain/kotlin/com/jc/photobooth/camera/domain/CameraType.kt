package com.jc.photobooth.camera.domain

/**
 * Supported camera types in the photobooth app
 */
enum class CameraType(val id: String, val displayName: String) {
    DEVICE_CAMERA("device_camera", "Device Camera"),
    SONY_A7III_MARK2("sony_a7iii_mark2", "Sony A7 III (Mark 2.0 - WiFi Transfer)"),
    MOCK_CAMERA("mock_camera", "Mock Camera (Testing)");

    companion object {
        fun fromId(id: String): CameraType? {
            return entries.find { it.id == id }
        }
    }
}
