package com.jc.photobooth.ui.photobooth.strategy

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.jc.photobooth.ui.photobooth.common.CountdownOverlay
import com.jc.photobooth.ui.photobooth.common.ErrorOverlay
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
    private val isConnected: Boolean
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
                    modifier = Modifier.fillMaxSize(),
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

        // Countdown overlay
        if (state is Mark2CaptureState.Countdown) {
            CountdownOverlay(
                remainingSeconds = state.remainingSeconds,
                photoIndex = state.photoIndex,
                totalPhotos = state.totalPhotos,
                textColor = Color.White
            )
        }

        // Capturing indicator
        if (state is Mark2CaptureState.Capturing) {
            StatusOverlay(
                icon = "📸",
                message = "Capturing photo ${state.photoIndex}..."
            )
        }

        // Downloading indicator
        if (state is Mark2CaptureState.Downloading) {
            StatusOverlay(
                icon = "📥",
                message = "Downloading photo ${state.photoIndex}..."
            )
        }

        // Photo preview overlay (shows photo on top of background)
        if (state is Mark2CaptureState.PhotoPreview) {
            PhotoPreviewOverlay(
                photo = state.photo,
                photoIndex = state.photoIndex,
                totalPhotos = state.totalPhotos
            )
        }

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
                    .width(200.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary
                )
            ) {
                Text(
                    text = "Start Photo Booth",
                    style = MaterialTheme.typography.titleMedium
                )
            }
        }
    }

    @Composable
    override fun TopRightContent(modifier: Modifier) {
        // Mark 2.0 badge
        Box(
            modifier = modifier
                .padding(16.dp)
                .background(
                    color = MaterialTheme.colorScheme.tertiary,
                    shape = MaterialTheme.shapes.small
                )
                .padding(horizontal = 12.dp, vertical = 6.dp)
        ) {
            Text(
                text = "Mark 2.0",
                color = MaterialTheme.colorScheme.onTertiary,
                style = MaterialTheme.typography.labelMedium
            )
        }
    }
}

/**
 * Photo preview overlay - displays captured photo with progress indicator.
 */
@Composable
private fun PhotoPreviewOverlay(
    photo: ImageBitmap,
    photoIndex: Int,
    totalPhotos: Int
) {
    Box(modifier = Modifier.fillMaxSize()) {
        // Full-screen photo
        Image(
            bitmap = photo,
            contentDescription = "Captured photo",
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Fit
        )

        // Progress indicator at top
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = 80.dp)
        ) {
            Text(
                text = "Photo $photoIndex of $totalPhotos",
                color = Color.White,
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier
                    .background(Color.Black.copy(alpha = 0.6f))
                    .padding(horizontal = 24.dp, vertical = 12.dp)
            )
        }
    }
}

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
