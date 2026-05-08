package com.jc.photobooth.ui.photobooth.sony.mark2

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jc.photobooth.camera.domain.openWiFiSettings
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.toImageBitmap
import com.jc.photobooth.network.ConnectionHealthState
import com.jc.photobooth.network.createNetworkMonitor
import com.jc.photobooth.ui.FullscreenEffect
import com.jc.photobooth.ui.knockbox.KnockboxFonts
import com.jc.photobooth.ui.knockbox.KnockboxFrame
import com.jc.photobooth.ui.knockbox.KnockboxTokens
import com.jc.photobooth.ui.knockbox.PlaceholderHues
import com.jc.photobooth.ui.overlay.ReconnectionDialog
import com.jc.photobooth.ui.photobooth.PhotoboothHost

/**
 * Sony A7 III Mark 2.0 photobooth screen using the shared [PhotoboothHost].
 *
 * The host owns the Attract → Countdown → Flash → Strip flow. This wrapper
 * supplies the live-view preview, the per-shot capture lambda, and renders
 * the connection / reconnection overlays into the host's overlay slot.
 */
@Composable
fun SonyMark2Screen(
    viewModel: SonyMark2ViewModel,
    settingsRepository: SettingsRepository,
    onHome: () -> Unit
) {
    FullscreenEffect()

    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) {
        if (!uiState.isConnected) viewModel.connect()
    }

    val networkMonitor = remember {
        createNetworkMonitor(
            cameraIpAddress = "http://192.168.122.1:8080",
            onHealthCheck = { viewModel.performHealthCheck() },
            onNetworkLost = { viewModel.handleNetworkLost() }
        )
    }

    DisposableEffect(uiState.isConnected) {
        if (uiState.isConnected) networkMonitor.startMonitoring()
        onDispose { networkMonitor.stopMonitoring() }
    }

    val networkStatus by networkMonitor.networkStatus.collectAsState()

    val showReconnectionDialog = uiState.autoReconnect is AutoReconnectState.InProgress ||
        uiState.autoReconnect is AutoReconnectState.GaveUp

    val dialogHealthState: ConnectionHealthState = when (val r = uiState.autoReconnect) {
        is AutoReconnectState.InProgress -> ConnectionHealthState.Reconnecting(r.attemptNumber)
        is AutoReconnectState.GaveUp -> ConnectionHealthState.Failed(
            "Unable to reconnect after 1 minute.\nCheck WiFi and try again."
        )
        is AutoReconnectState.Idle -> networkStatus.healthState
    }

    PhotoboothHost(
        livePreview = {
            val frame = uiState.liveViewFrame
            Box(
                modifier = Modifier.fillMaxSize().background(Color.Black),
                contentAlignment = Alignment.Center
            ) {
                if (frame != null) {
                    Image(
                        bitmap = frame,
                        contentDescription = "Live view",
                        modifier = Modifier
                            .fillMaxSize()
                            .graphicsLayer { scaleX = -1f },
                        contentScale = ContentScale.Fit
                    )
                } else {
                    ConnectingOverlay()
                }
            }
        },
        captureFrame = { index ->
            val photo = viewModel.captureSingle()
            KnockboxFrame(
                hue = PlaceholderHues[index % PlaceholderHues.size],
                label = "shot ${index + 1}",
                image = photo.toImageBitmap()
            )
        },
        startTrigger = viewModel.startSignal,
        overlay = {
            ReconnectionDialog(
                isVisible = showReconnectionDialog,
                connectionState = dialogHealthState,
                onOpenWifiSettings = { openWiFiSettings() },
                onContinueAnyway = { viewModel.dismissReconnection() },
                onRetry = { viewModel.manualRetry() }
            )
        },
        errorSlot = {
            uiState.connectionError?.let { msg ->
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.7f)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = msg,
                        color = KnockboxTokens.Paper,
                        fontFamily = KnockboxFonts.Sans,
                        fontWeight = FontWeight.Medium,
                        fontSize = 18.sp,
                        modifier = Modifier.padding(32.dp)
                    )
                }
            }
        }
    )
}

@Composable
private fun ConnectingOverlay() {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        CircularProgressIndicator(color = KnockboxTokens.Paper)
        Text(
            text = "Connecting to camera…",
            color = KnockboxTokens.Paper,
            fontFamily = KnockboxFonts.Sans,
            fontSize = 16.sp
        )
    }
}
