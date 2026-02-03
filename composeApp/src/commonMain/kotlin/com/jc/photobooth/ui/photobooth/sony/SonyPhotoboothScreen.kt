package com.jc.photobooth.ui.photobooth.sony

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.jc.photobooth.camera.data.sony.SonyA7IIICamera
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.ui.photobooth.common.PhotoboothLayout
import com.jc.photobooth.ui.photobooth.strategy.SonyMark1Strategy

/**
 * Sony A7 III Photobooth Screen (Mark 1.1 - Screenshot Workflow).
 *
 * Displays live view from camera and handles multi-photo capture sequence
 * with countdown timer and frame freezing.
 *
 * @param camera Sony A7 III camera instance
 * @param settingsRepository Settings repository for photobooth config
 * @param onNavigateToPhotoStrip Callback when capture complete with photos
 * @param onNavigateHome Callback to return to home screen
 */
@Composable
fun SonyPhotoboothScreen(
    camera: SonyA7IIICamera,
    settingsRepository: SettingsRepository,
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit
) {
    val viewModel = remember {
        println("[SONY_PB_SCREEN] Creating ViewModel")
        println("[SONY_PB_SCREEN] Camera: $camera")
        println("[SONY_PB_SCREEN] Camera connection: ${camera.connectionState.value}")
        SonyPhotoboothViewModel(camera, settingsRepository)
    }

    val uiState by viewModel.uiState.collectAsState()

    // Only log state changes, not every recomposition
    LaunchedEffect(uiState.captureState) {
        println("[SONY_PB_SCREEN] Capture state changed: ${uiState.captureState}")
    }

    // Auto-connect and start live view when screen opens
    LaunchedEffect(Unit) {
        println("[SONY_PB_SCREEN] LaunchedEffect: Checking camera connection...")
        val connectionState = camera.connectionState.value
        println("[SONY_PB_SCREEN] Current connection state: $connectionState")

        if (connectionState !is com.jc.photobooth.camera.domain.ConnectionState.Connected) {
            println("[SONY_PB_SCREEN] Camera not connected, connecting now...")
            val result = camera.connect()
            if (result.isSuccess) {
                println("[SONY_PB_SCREEN] Camera connected successfully!")
            } else {
                println("[SONY_PB_SCREEN] ERROR: Failed to connect camera: ${result.exceptionOrNull()?.message}")
            }
        } else {
            println("[SONY_PB_SCREEN] Camera already connected")
        }

        // Check if live view is active
        val liveViewFrame = camera.liveViewFrame.value
        println("[SONY_PB_SCREEN] Live view frame: ${liveViewFrame != null}")

        if (liveViewFrame == null) {
            println("[SONY_PB_SCREEN] Live view not active, starting now...")
            val result = camera.startLiveView()
            if (result.isSuccess) {
                println("[SONY_PB_SCREEN] Live view started successfully!")
            } else {
                println("[SONY_PB_SCREEN] ERROR: Failed to start live view: ${result.exceptionOrNull()?.message}")
            }
        } else {
            println("[SONY_PB_SCREEN] Live view already active")
        }
    }

    // Auto-navigate to photo strip when capture complete
    LaunchedEffect(uiState.captureState) {
        if (uiState.captureState is SonyCaptureState.Complete) {
            println("[SONY_PB_SCREEN] Capture complete! Navigating to photo strip...")
            val photos = (uiState.captureState as SonyCaptureState.Complete).photos
            onNavigateToPhotoStrip(photos)
            viewModel.resetCapture()
        }
    }

    val strategy = remember(uiState.liveViewState) {
        SonyMark1Strategy(liveViewState = uiState.liveViewState)
    }

    PhotoboothLayout(
        contentStrategy = strategy,
        captureState = uiState.captureState,
        onHomeClick = onNavigateHome,
        onCaptureClick = { viewModel.startCaptureSequence() },
        onErrorDismiss = { viewModel.resetCapture() }
    )
}

