package com.jc.photobooth.ui.photobooth.strategy

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.jc.photobooth.gesture.GestureResult
import com.jc.photobooth.ui.photobooth.common.BorderOverlay
import com.jc.photobooth.ui.photobooth.common.CountdownOverlay
import com.jc.photobooth.ui.photobooth.common.ErrorOverlay
import com.jc.photobooth.ui.photobooth.common.GestureInstructionOverlay
import com.jc.photobooth.ui.photobooth.common.HandDetectionOverlay
import com.jc.photobooth.ui.photobooth.common.StatusOverlay
import com.jc.photobooth.ui.photobooth.sony.mark2.Mark2CaptureState

/**
 * Content strategy for Sony A7 III Mark 2.0 photobooth.
 *
 * Uses WiFi transfer workflow - captures actual photos via actTakePicture API,
 * downloads them over WiFi, and displays photo previews between captures.
 *
 * @param liveViewFrame Current live view frame (or null if not available)
 * @param isConnected Whether camera is currently connected
 */
class SonyMark2Strategy(
    private val liveViewFrame: ImageBitmap?,
    private val isConnected: Boolean,
    private val gestureResult: GestureResult? = null
) : PhotoboothContentStrategy {

    @Composable
    override fun CameraContent(modifier: Modifier) {
        // Show live view or photo preview as background
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(Color.Black),
            contentAlignment = Alignment.Center
        ) {
            if (liveViewFrame != null) {
                Image(
                    bitmap = liveViewFrame,
                    contentDescription = "Live view",
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer { scaleX = -1f },
                    contentScale = ContentScale.Fit
                )
            } else {
                Text(
                    text = "Waiting for live view...",
                    color = Color.White,
                    style = MaterialTheme.typography.bodyLarge
                )
            }
        }
    }

    @Composable
    override fun StateOverlays(
        captureState: Any,
        onErrorDismiss: (() -> Unit)?,
        modifier: Modifier
    ) {
        val state = captureState as Mark2CaptureState

        // Hand detection overlay (idle state only)
        if (state is Mark2CaptureState.Idle && gestureResult != null) {
            HandDetectionOverlay(
                boundingBox = gestureResult.boundingBox,
                isMirrored = true
            )
        }

        // Gesture instructions (idle state only)
        GestureInstructionOverlay(
            isVisible = state is Mark2CaptureState.Idle && isConnected
        )

        // Countdown overlay
        if (state is Mark2CaptureState.Countdown) {
            CountdownOverlay(
                remainingSeconds = state.remainingSeconds,
                photoIndex = state.photoIndex,
                totalPhotos = state.totalPhotos,
                textColor = Color.White
            )
        }

        // Flash effect removed - timing issues

        // White border during capture
        if (state is Mark2CaptureState.Capturing) {
            BorderOverlay(isVisible = true)
        }

        // Downloading removed - downloads are fast, no need to show status

        // Photo preview removed - live view remains active

        // Connecting indicator
        if (!isConnected && state !is Mark2CaptureState.Error) {
            ConnectingOverlay()
        }

        // Error message
        if (state is Mark2CaptureState.Error && onErrorDismiss != null) {
            ErrorOverlay(
                message = state.message,
                onDismiss = onErrorDismiss,
                onRetry = onErrorDismiss, // For now, same handler (can be customized later)
                helperText = "Make sure camera is in Single Shooting mode\nwith JPEG or RAW+JPEG format"
            )
        }
    }

    @Composable
    override fun ActionButtons(
        captureState: Any,
        onCaptureClick: () -> Unit,
        modifier: Modifier
    ) {
        val state = captureState as Mark2CaptureState

        // Show start button only when idle and connected
        if (state is Mark2CaptureState.Idle && isConnected) {
            Button(
                onClick = onCaptureClick,
                modifier = modifier
                    .padding(bottom = 48.dp)
                    .width(240.dp)
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary
                )
            ) {
                Text(
                    text = "Start Photostrip",
                    style = MaterialTheme.typography.titleLarge
                )
            }
        }
    }

    @Composable
    override fun TopRightContent(modifier: Modifier) {
        // No overlay - removed to avoid distraction
    }
}

// PhotoPreviewOverlay removed - no longer needed

/**
 * Connecting overlay - shows while establishing camera connection.
 */
@Composable
private fun ConnectingOverlay() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.7f)),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = Color.White)
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Connecting to camera...",
                color = Color.White,
                style = MaterialTheme.typography.bodyLarge
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Ensure camera is in Single Shooting mode\nwith JPEG or RAW+JPEG format",
                color = Color.White.copy(alpha = 0.7f),
                style = MaterialTheme.typography.bodySmall,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center
            )
        }
    }
}
