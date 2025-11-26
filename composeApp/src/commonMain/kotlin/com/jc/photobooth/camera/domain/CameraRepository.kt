package com.jc.photobooth.camera.domain

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.jc.photobooth.camera.data.device.DeviceCamera
import com.jc.photobooth.camera.data.sony.SonyA7IIICamera
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Repository for managing camera sources and user preferences.
 * Handles camera selection and switching between different camera implementations.
 */
class CameraRepository(
    private val dataStore: DataStore<Preferences>
) {
    companion object {
        private val SELECTED_CAMERA_KEY = stringPreferencesKey("selected_camera")
        private val SONY_CAMERA_IP_KEY = stringPreferencesKey("sony_camera_ip")
        private val SONY_CAMERA_SSID_KEY = stringPreferencesKey("sony_camera_ssid")
        private val SONY_CAMERA_PASSWORD_KEY = stringPreferencesKey("sony_camera_password")
    }

    private val deviceCamera: DeviceCamera = DeviceCamera()
    private var sonyCamera: SonyA7IIICamera? = null

    /**
     * Get the flow of selected camera type
     */
    val selectedCameraType: Flow<CameraType> = dataStore.data.map { preferences ->
        val cameraId = preferences[SELECTED_CAMERA_KEY] ?: CameraType.DEVICE_CAMERA.id
        CameraType.fromId(cameraId) ?: CameraType.DEVICE_CAMERA
    }

    /**
     * Get available cameras
     */
    suspend fun getAvailableCameras(): List<CameraType> {
        return buildList {
            // Device camera is always available (even if not fully implemented)
            if (deviceCamera.isAvailable()) {
                add(CameraType.DEVICE_CAMERA)
            }

            // Sony A7 III is available if user has configured it
            add(CameraType.SONY_A7III)
        }
    }

    /**
     * Get the currently selected camera instance
     */
    suspend fun getCurrentCamera(): PhotoboothCamera {
        val cameraType = dataStore.data.map { preferences ->
            val cameraId = preferences[SELECTED_CAMERA_KEY] ?: CameraType.DEVICE_CAMERA.id
            CameraType.fromId(cameraId) ?: CameraType.DEVICE_CAMERA
        }.first()

        return getCameraInstance(cameraType)
    }

    /**
     * Get a specific camera instance
     */
    fun getCameraInstance(type: CameraType): PhotoboothCamera {
        return when (type) {
            CameraType.DEVICE_CAMERA -> deviceCamera
            CameraType.SONY_A7III -> {
                // Lazy initialization of Sony camera
                if (sonyCamera == null) {
                    sonyCamera = SonyA7IIICamera()
                }
                sonyCamera!!
            }
        }
    }

    /**
     * Set the selected camera type
     */
    suspend fun setSelectedCamera(type: CameraType) {
        dataStore.edit { preferences ->
            preferences[SELECTED_CAMERA_KEY] = type.id
        }
    }

    /**
     * Get Sony camera WiFi configuration
     */
    suspend fun getSonyCameraConfig(): SonyCameraConfig {
        return dataStore.data.map { preferences ->
            SonyCameraConfig(
                ip = preferences[SONY_CAMERA_IP_KEY] ?: "192.168.122.1",
                ssid = preferences[SONY_CAMERA_SSID_KEY] ?: "",
                password = preferences[SONY_CAMERA_PASSWORD_KEY] ?: ""
            )
        }.first()
    }

    /**
     * Save Sony camera WiFi configuration
     */
    suspend fun saveSonyCameraConfig(config: SonyCameraConfig) {
        dataStore.edit { preferences ->
            preferences[SONY_CAMERA_IP_KEY] = config.ip
            preferences[SONY_CAMERA_SSID_KEY] = config.ssid
            preferences[SONY_CAMERA_PASSWORD_KEY] = config.password
        }

        // Recreate Sony camera instance with new config
        sonyCamera?.close()
        sonyCamera = SonyA7IIICamera(config.ip)
    }

    /**
     * Disconnect all cameras
     */
    suspend fun disconnectAll() {
        deviceCamera.disconnect()
        sonyCamera?.disconnect()
    }
}

/**
 * Sony camera WiFi configuration
 */
data class SonyCameraConfig(
    val ip: String = "192.168.122.1",
    val ssid: String = "",
    val password: String = ""
)
