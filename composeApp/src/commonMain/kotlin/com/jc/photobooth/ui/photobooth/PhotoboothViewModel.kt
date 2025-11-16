package com.jc.photobooth.ui.photobooth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jc.photobooth.camera.CameraController
import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.permissions.CameraPermissionHandler
import com.jc.photobooth.permissions.PermissionState
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class PhotoboothViewModel(
    private val permissionHandler: CameraPermissionHandler,
    private val cameraController: CameraController,
    private val config: PhotoboothConfig = PhotoboothConfig()
) : ViewModel() {

    private val _uiState = MutableStateFlow(PhotoboothUiState(config = config))
    val uiState: StateFlow<PhotoboothUiState> = _uiState.asStateFlow()

    init {
        checkPermission()
    }

    fun checkPermission() {
        val state = permissionHandler.checkPermission()
        _uiState.update { it.copy(permissionState = state) }
    }

    fun onPermissionRequested() {
        _uiState.update { it.copy(isPermissionRequested = true) }
    }

    fun updatePermissionState(state: PermissionState) {
        _uiState.update { it.copy(permissionState = state) }
    }

    fun openSettings() {
        permissionHandler.openSettings()
    }

    fun startCaptureSequence() {
        viewModelScope.launch {
            try {
                val photos = mutableListOf<PhotoData>()

                repeat(config.numberOfPhotos) { index ->
                    // Countdown phase
                    for (countdown in config.countdownSeconds downTo 1) {
                        _uiState.update {
                            it.copy(
                                captureState = CaptureState.Countdown(
                                    remainingSeconds = countdown,
                                    photoIndex = index + 1,
                                    totalPhotos = config.numberOfPhotos
                                )
                            )
                        }
                        delay(1000L)
                    }

                    // Capture phase
                    _uiState.update {
                        it.copy(captureState = CaptureState.Capturing(photoIndex = index + 1))
                    }

                    val photo = cameraController.capturePhoto()
                    photos.add(photo)

                    // Brief pause between photos
                    if (index < config.numberOfPhotos - 1) {
                        delay(500L)
                    }
                }

                // Complete phase
                _uiState.update {
                    it.copy(captureState = CaptureState.Complete(photos))
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(captureState = CaptureState.Error(e.message ?: "Unknown error"))
                }
            }
        }
    }

    fun resetCapture() {
        _uiState.update { it.copy(captureState = CaptureState.Idle) }
    }

    override fun onCleared() {
        super.onCleared()
        cameraController.release()
    }
}
