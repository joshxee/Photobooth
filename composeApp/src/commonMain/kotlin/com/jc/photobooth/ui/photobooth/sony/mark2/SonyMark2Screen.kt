package com.jc.photobooth.ui.photobooth.sony.mark2

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.ui.photobooth.common.PhotoboothLayout
import com.jc.photobooth.ui.photobooth.strategy.SonyMark2Strategy

/**
 * Sony A7 III Mark 2.0 Photobooth Screen.
 *
 * Uses actTakePicture API and downloads actual photos via WiFi.
 * Requires camera to be in Single Shooting mode with JPEG/RAW+JPEG format.
 *
 * @param settingsRepository Settings repository for photobooth config
 * @param onNavigateToPhotoStrip Callback when capture complete with photos
 * @param onNavigateHome Callback to return to home screen
 */
@Composable
fun SonyMark2Screen(
    settingsRepository: SettingsRepository,
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit
) {
    val viewModel = remember { SonyMark2ViewModel(settingsRepository) }
    val uiState by viewModel.uiState.collectAsState()

    // Auto-connect when screen opens
    LaunchedEffect(Unit) {
        viewModel.connect()
    }

    // Auto-navigate to photo strip when capture complete
    LaunchedEffect(uiState.captureState) {
        if (uiState.captureState is Mark2CaptureState.Complete) {
            val photos = (uiState.captureState as Mark2CaptureState.Complete).photos
            if (photos.isNotEmpty()) {
                onNavigateToPhotoStrip(photos)
                viewModel.resetCapture()
            }
        }
    }

    val strategy = remember(uiState.liveViewFrame, uiState.isConnected) {
        SonyMark2Strategy(
            liveViewFrame = uiState.liveViewFrame,
            isConnected = uiState.isConnected
        )
    }

    PhotoboothLayout(
        contentStrategy = strategy,
        captureState = uiState.captureState,
        onHomeClick = onNavigateHome,
        onCaptureClick = { viewModel.startCaptureSequence() },
        onErrorDismiss = { viewModel.resetCapture() }
    )
}

