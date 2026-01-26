package com.jc.photobooth.ui.photobooth.sony.mark2

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData

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

    Box(modifier = Modifier.fillMaxSize()) {
        // Background: Live view or photo preview
        when (val state = uiState.captureState) {
            is Mark2CaptureState.PhotoPreview -> {
                PhotoPreviewDisplay(photo = state.photo)
            }
            else -> {
                LiveViewDisplay(frame = uiState.liveViewFrame)
            }
        }

        // Countdown overlay
        val captureState = uiState.captureState
        if (captureState is Mark2CaptureState.Countdown) {
            CountdownOverlay(
                remainingSeconds = captureState.remainingSeconds,
                photoIndex = captureState.photoIndex,
                totalPhotos = captureState.totalPhotos
            )
        }

        // Capturing indicator
        if (captureState is Mark2CaptureState.Capturing) {
            StatusOverlay(
                icon = "📸",
                message = "Capturing photo ${captureState.photoIndex}..."
            )
        }

        // Downloading indicator
        if (captureState is Mark2CaptureState.Downloading) {
            StatusOverlay(
                icon = "📥",
                message = "Downloading photo ${captureState.photoIndex}..."
            )
        }

        // Photo preview indicator
        if (captureState is Mark2CaptureState.PhotoPreview) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 80.dp)
            ) {
                Text(
                    text = "Photo ${captureState.photoIndex} of ${captureState.totalPhotos}",
                    color = Color.White,
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier
                        .background(Color.Black.copy(alpha = 0.6f))
                        .padding(horizontal = 24.dp, vertical = 12.dp)
                )
            }
        }

        // Home button (top-left)
        IconButton(
            onClick = onNavigateHome,
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(16.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Home,
                contentDescription = "Home",
                tint = Color.White,
                modifier = Modifier.size(32.dp)
            )
        }

        // Mark 2.0 badge (top-right)
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
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

        // Start button (only when Idle and connected)
        if (captureState is Mark2CaptureState.Idle && uiState.isConnected) {
            Button(
                onClick = { viewModel.startCaptureSequence() },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
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

        // Connecting indicator
        if (!uiState.isConnected && captureState !is Mark2CaptureState.Error) {
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
                        textAlign = TextAlign.Center
                    )
                }
            }
        }

        // Error message
        if (captureState is Mark2CaptureState.Error) {
            ErrorMessage(
                message = captureState.message,
                onDismiss = { viewModel.resetCapture() },
                onRetry = { viewModel.connect() }
            )
        }
    }
}

/**
 * Live view display
 */
@Composable
private fun LiveViewDisplay(frame: ImageBitmap?) {
    Box(
        modifier = Modifier
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
 * Photo preview display (shows downloaded photo)
 */
@Composable
private fun PhotoPreviewDisplay(photo: ImageBitmap) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
        contentAlignment = Alignment.Center
    ) {
        Image(
            bitmap = photo,
            contentDescription = "Captured photo",
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Fit
        )
    }
}

/**
 * Countdown overlay
 */
@Composable
private fun CountdownOverlay(
    remainingSeconds: Int,
    photoIndex: Int,
    totalPhotos: Int
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "$remainingSeconds",
                style = MaterialTheme.typography.displayLarge,
                fontSize = 120.sp,
                color = Color.White
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Photo $photoIndex of $totalPhotos",
                style = MaterialTheme.typography.headlineMedium,
                color = Color.White.copy(alpha = 0.8f)
            )
        }
    }
}

/**
 * Status overlay (capturing/downloading)
 */
@Composable
private fun StatusOverlay(
    icon: String,
    message: String
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.5f)),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = icon,
                fontSize = 64.sp
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = message,
                color = Color.White,
                style = MaterialTheme.typography.headlineSmall
            )
            Spacer(modifier = Modifier.height(16.dp))
            CircularProgressIndicator(color = Color.White)
        }
    }
}

/**
 * Error message with retry option
 */
@Composable
private fun ErrorMessage(
    message: String,
    onDismiss: () -> Unit,
    onRetry: () -> Unit
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.BottomCenter
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.errorContainer
            )
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "Error",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Make sure camera is in Single Shooting mode\nwith JPEG or RAW+JPEG format",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer.copy(alpha = 0.7f),
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(16.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    OutlinedButton(onClick = onDismiss) {
                        Text("Cancel")
                    }
                    Button(onClick = onRetry) {
                        Text("Retry")
                    }
                }
            }
        }
    }
}
