package com.jc.photobooth.ui.photobooth.sony.mark2

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.jc.photobooth.camera.domain.openWiFiSettings
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.network.ConnectionHealthState
import com.jc.photobooth.network.createNetworkMonitor
import com.jc.photobooth.ui.FullscreenEffect
import com.jc.photobooth.ui.overlay.ConnectionStatusOverlay
import com.jc.photobooth.ui.overlay.ReconnectionDialog
import com.jc.photobooth.ui.photobooth.common.PhotoboothLayout
import com.jc.photobooth.ui.photobooth.strategy.SonyMark2Strategy

/**
 * Sony A7 III Mark 2.0 Photobooth Screen.
 *
 * Uses actTakePicture API and downloads actual photos via WiFi.
 * Requires camera to be in Single Shooting mode with JPEG/RAW+JPEG format.
 *
 * Automatically enters fullscreen/immersive mode when displayed.
 *
 * @param viewModel The SonyMark2ViewModel (hoisted for persistent sessions)
 * @param settingsRepository Settings repository for photobooth config
 * @param onNavigateToPhotoStrip Callback when capture complete with photos
 * @param onNavigateHome Callback to return to home screen
 */
@Composable
fun SonyMark2Screen(
    viewModel: SonyMark2ViewModel = remember { SonyMark2ViewModel(settingsRepository = error("settingsRepository required")) },
    settingsRepository: SettingsRepository,
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit
) {
    // Enter fullscreen mode when this screen is displayed
    FullscreenEffect()

    val uiState by viewModel.uiState.collectAsState()

    // Attempt to connect once when the screen first opens.
    // Subsequent reconnections are handled by the ViewModel's auto-reconnect loop.
    LaunchedEffect(Unit) {
        if (!uiState.isConnected) {
            viewModel.connect()
        }
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

    val strategy = remember(uiState.liveViewFrame, uiState.isConnected, uiState.gestureResult) {
        SonyMark2Strategy(
            liveViewFrame = uiState.liveViewFrame,
            isConnected = uiState.isConnected,
            gestureResult = uiState.gestureResult
        )
    }

    // Network monitor for WiFi health checks (5-second intervals)
    val networkMonitor = remember {
        createNetworkMonitor(
            cameraIpAddress = "http://192.168.122.1:8080",
            onHealthCheck = {
                // Delegate to ViewModel's API client for camera health check
                viewModel.performHealthCheck()
            },
            onNetworkLost = {
                // Connection lost - trigger reconnection in ViewModel
                viewModel.handleNetworkLost()
            }
        )
    }

    // Start/stop monitoring based on connection state
    DisposableEffect(uiState.isConnected) {
        if (uiState.isConnected) {
            // Only start monitoring after camera is connected
            networkMonitor.startMonitoring()
        }
        onDispose {
            networkMonitor.stopMonitoring()
        }
    }

    // Collect network status
    val networkStatus by networkMonitor.networkStatus.collectAsState()

    // Show the reconnection dialog whenever we are actively trying to reconnect
    // or have given up — regardless of capture state (including Idle).
    // Does NOT show during the initial connection attempt (autoReconnect starts as Idle).
    val showReconnectionDialog = uiState.autoReconnect is AutoReconnectState.InProgress ||
        uiState.autoReconnect is AutoReconnectState.GaveUp

    // Map ViewModel reconnect state → ConnectionHealthState for the dialog UI.
    val dialogHealthState: ConnectionHealthState = when (val reconnect = uiState.autoReconnect) {
        is AutoReconnectState.InProgress ->
            ConnectionHealthState.Reconnecting(reconnect.attemptNumber)
        is AutoReconnectState.GaveUp ->
            ConnectionHealthState.Failed("Unable to reconnect after 1 minute.\nCheck WiFi and try again.")
        is AutoReconnectState.Idle ->
            networkStatus.healthState
    }

    Box(modifier = Modifier.fillMaxSize()) {
        PhotoboothLayout(
            contentStrategy = strategy,
            captureState = uiState.captureState,
            onHomeClick = onNavigateHome,
            onCaptureClick = { viewModel.startCaptureSequence() },
            onErrorDismiss = { viewModel.resetCapture() }
        )

        // Connection status overlay removed - less distracting
        // Polling still active in background to trigger reconnection dialog if needed

        // Reconnection dialog — shown in all states when disconnected (including Idle).
        // Triggered by stale live view or WiFi loss, not by initial connect failures.
        ReconnectionDialog(
            isVisible = showReconnectionDialog,
            connectionState = dialogHealthState,
            onOpenWifiSettings = {
                openWiFiSettings()
            },
            onContinueAnyway = {
                viewModel.dismissReconnection()
            },
            onRetry = {
                // Restart the full 60-second reconnect window immediately
                viewModel.manualRetry()
            }
        )
    }
}
