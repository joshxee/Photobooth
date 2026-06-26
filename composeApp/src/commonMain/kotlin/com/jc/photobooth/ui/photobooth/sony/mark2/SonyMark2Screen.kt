package com.jc.photobooth.ui.photobooth.sony.mark2

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jc.photobooth.gesture.HandBoundingBox
import com.jc.photobooth.camera.domain.openWiFiSettings
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.model.toImageBitmap
import com.jc.photobooth.network.ConnectionHealthState
import com.jc.photobooth.network.createNetworkMonitor
import com.jc.photobooth.ui.FullscreenEffect
import com.jc.photobooth.ui.knockbox.KnockboxFonts
import com.jc.photobooth.ui.knockbox.KnockboxFrame
import com.jc.photobooth.ui.knockbox.KnockboxPill
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
    settingsRepository: SettingsRepository
) {
    FullscreenEffect()

    val uiState by viewModel.uiState.collectAsState()
    val config by settingsRepository.getConfig().collectAsState(initial = PhotoboothConfig())

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
        totalShots = config.numberOfPhotos,
        countdownSeconds = config.countdownSeconds,
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
            uiState.gestureResult?.let { gesture ->
                HandDetectionOverlay(boundingBox = gesture.boundingBox)
            }
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
                ConnectionErrorCard(
                    message = msg,
                    onRetry = { viewModel.connect() }
                )
            }
        }
    )
}

@Composable
private fun ConnectionErrorCard(message: String, onRetry: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.78f)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .padding(32.dp)
                .clip(RoundedCornerShape(KnockboxTokens.RadiusMedium))
                .background(Color.White.copy(alpha = 0.06f))
                .border(
                    width = 1.dp,
                    color = Color.White.copy(alpha = 0.16f),
                    shape = RoundedCornerShape(KnockboxTokens.RadiusMedium)
                )
                .padding(horizontal = 28.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            horizontalAlignment = Alignment.Start
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(KnockboxTokens.ForestSoft),
                contentAlignment = Alignment.Center
            ) {
                Text(text = "!", color = KnockboxTokens.Forest, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            }
            Text(
                text = "Couldn't reach the camera",
                color = KnockboxTokens.Paper,
                fontFamily = KnockboxFonts.Sans,
                fontWeight = FontWeight.Medium,
                fontSize = 22.sp
            )
            Text(
                text = message,
                color = KnockboxTokens.Paper.copy(alpha = 0.7f),
                fontFamily = KnockboxFonts.Sans,
                fontSize = 14.sp
            )
            KnockboxPill(
                label = "Retry connection",
                onClick = onRetry
            )
        }
    }
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

@Composable
private fun HandDetectionOverlay(boundingBox: HandBoundingBox) {
    Canvas(modifier = Modifier.fillMaxSize()) {

        val left: Float = (1f - boundingBox.right) * size.width
        val right: Float = (1f - boundingBox.left) * size.width

        val top = boundingBox.top * size.height
        val bottom = boundingBox.bottom * size.height
        drawRect(
            color = Color.White,
            topLeft = Offset(left, top),
            size = Size(right - left, bottom - top),
            style = Stroke(width = 6f)
        )
    }
}
