package com.jc.photobooth.ui.photobooth.strategy

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.jc.photobooth.ui.photobooth.common.CountdownOverlay
import com.jc.photobooth.ui.photobooth.common.ErrorOverlay
import com.jc.photobooth.ui.photobooth.sony.LiveViewState
import com.jc.photobooth.ui.photobooth.sony.SonyCaptureState

/**
 * Content strategy for Sony A7 III Mark 1.1 photobooth.
 *
 * Uses live view screenshot workflow - freezes frame at countdown 0,
 * triggers continuous shooting, and captures screenshots as photos.
 *
 * @param liveViewState Current live view state (active or frozen)
 */
class SonyMark1Strategy(
    private val liveViewState: LiveViewState
) : PhotoboothContentStrategy {

    @Composable
    override fun CameraContent(modifier: Modifier) {
        when (liveViewState) {
            is LiveViewState.Active -> {
                LiveViewDisplay(frame = liveViewState.frame, modifier = modifier)
            }
            is LiveViewState.Frozen -> {
                FrozenFrameDisplay(frame = liveViewState.frame, modifier = modifier)
            }
        }
    }

    @Composable
    override fun StateOverlays(
        captureState: Any,
        onErrorDismiss: (() -> Unit)?,
        modifier: Modifier
    ) {
        val state = captureState as SonyCaptureState

        // Countdown overlay
        if (state is SonyCaptureState.Countdown) {
            CountdownOverlay(
                remainingSeconds = state.remainingSeconds,
                photoIndex = state.photoIndex,
                totalPhotos = state.totalPhotos
            )
        }

        // Capturing indicator
        if (state is SonyCaptureState.Capturing) {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "📸 Capturing ${state.photoIndex}...",
                    color = Color.White,
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier
                        .background(Color.Black.copy(alpha = 0.7f))
                        .padding(16.dp)
                )
            }
        }

        // Error message
        if (state is SonyCaptureState.Error && onErrorDismiss != null) {
            ErrorOverlay(
                message = state.message,
                onDismiss = onErrorDismiss
            )
        }
    }

    @Composable
    override fun ActionButtons(
        captureState: Any,
        onCaptureClick: () -> Unit,
        modifier: Modifier
    ) {
        val state = captureState as SonyCaptureState

        // Show start button only when idle
        if (state is SonyCaptureState.Idle) {
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

    // No top-right content for Mark 1.1
}

/**
 * Displays active live view from camera.
 */
@Composable
private fun LiveViewDisplay(frame: ImageBitmap?, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black),
        contentAlignment = Alignment.Center
    ) {
        if (frame != null) {
            Image(
                bitmap = frame,
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

/**
 * Displays frozen live view frame (captured at countdown 0).
 */
@Composable
private fun FrozenFrameDisplay(frame: ImageBitmap, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black),
        contentAlignment = Alignment.Center
    ) {
        Image(
            bitmap = frame,
            contentDescription = "Frozen frame",
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Fit
        )
    }
}
