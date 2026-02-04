package com.jc.photobooth.ui.photobooth.strategy

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.CameraController
import com.jc.photobooth.ui.photobooth.CameraPreview
import com.jc.photobooth.ui.photobooth.CaptureState
import com.jc.photobooth.ui.photobooth.common.CountdownOverlay

/**
 * Content strategy for native device camera photobooth.
 *
 * Uses CameraX (Android) or platform camera APIs to display live camera preview
 * and capture photos directly from the device camera.
 *
 * @param cameraController Platform-specific camera controller
 * @param onSettingsClick Callback when settings button is clicked
 */
class NativeContentStrategy(
    private val cameraController: CameraController,
    private val onSettingsClick: () -> Unit
) : PhotoboothContentStrategy {

    @Composable
    override fun CameraContent(modifier: Modifier) {
        CameraPreview(
            controller = cameraController,
            modifier = modifier
        )
    }

    @Composable
    override fun StateOverlays(
        captureState: Any,
        onErrorDismiss: (() -> Unit)?,
        modifier: Modifier
    ) {
        val state = captureState as CaptureState

        // Countdown overlay
        if (state is CaptureState.Countdown) {
            CountdownOverlay(
                remainingSeconds = state.remainingSeconds,
                photoIndex = state.photoIndex,
                totalPhotos = state.totalPhotos
            )
        }

        // Error display (simple text on error background)
        if (state is CaptureState.Error) {
            androidx.compose.material3.Text(
                text = state.message,
                modifier = Modifier
                    .padding(16.dp)
                    .background(MaterialTheme.colorScheme.error)
                    .padding(16.dp),
                color = MaterialTheme.colorScheme.onError
            )
        }
    }

    @Composable
    override fun ActionButtons(
        captureState: Any,
        onCaptureClick: () -> Unit,
        modifier: Modifier
    ) {
        val state = captureState as CaptureState

        // Show capture button only when idle
        if (state is CaptureState.Idle) {
            OutlinedButton(
                onClick = onCaptureClick,
                modifier = modifier
                    .padding(32.dp)
                    .width(200.dp),
                border = BorderStroke(1.dp, Color.White),
                shape = RectangleShape
            ) {
                Icon(
                    imageVector = Icons.Default.CameraAlt,
                    contentDescription = "Capture",
                    tint = Color.White
                )
                Spacer(Modifier.width(8.dp))
                Text("Capture", color = Color.White)
            }
        }
    }

    @Composable
    override fun TopRightContent(modifier: Modifier) {
        IconButton(
            onClick = onSettingsClick,
            modifier = modifier.padding(16.dp)
        ) {
            Icon(
                imageVector = Icons.Filled.Settings,
                contentDescription = "Settings",
                tint = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}
