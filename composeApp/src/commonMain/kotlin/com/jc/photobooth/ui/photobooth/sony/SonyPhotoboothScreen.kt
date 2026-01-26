package com.jc.photobooth.ui.photobooth.sony

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
import com.jc.photobooth.camera.data.sony.SonyA7IIICamera
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData

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

    Box(modifier = Modifier.fillMaxSize()) {
        // Live view or frozen frame background
        when (val lvState = uiState.liveViewState) {
            is LiveViewState.Active -> {
                LiveViewDisplay(frame = lvState.frame)
            }
            is LiveViewState.Frozen -> {
                FrozenFrameDisplay(frame = lvState.frame)
            }
        }

        // Countdown overlay
        if (uiState.captureState is SonyCaptureState.Countdown) {
            val countdown = uiState.captureState as SonyCaptureState.Countdown
            CountdownOverlay(
                remainingSeconds = countdown.remainingSeconds,
                photoIndex = countdown.photoIndex,
                totalPhotos = countdown.totalPhotos
            )
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

        // Capture button (only show when Idle)
        if (uiState.captureState is SonyCaptureState.Idle) {
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

        // Error message
        if (uiState.captureState is SonyCaptureState.Error) {
            val error = uiState.captureState as SonyCaptureState.Error
            ErrorMessage(
                message = error.message,
                onDismiss = { viewModel.resetCapture() }
            )
        }

        // Capturing indicator
        if (uiState.captureState is SonyCaptureState.Capturing) {
            val capturing = uiState.captureState as SonyCaptureState.Capturing
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(32.dp)
            ) {
                Text(
                    text = "📸 Capturing ${capturing.photoIndex}...",
                    color = Color.White,
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier
                        .background(Color.Black.copy(alpha = 0.7f))
                        .padding(16.dp)
                )
            }
        }
    }
}

/**
 * Displays active live view from camera.
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
 * Displays frozen live view frame (captured at countdown 0).
 */
@Composable
private fun FrozenFrameDisplay(frame: ImageBitmap) {
    Box(
        modifier = Modifier
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

/**
 * Countdown overlay (3...2...1).
 */
@Composable
private fun CountdownOverlay(
    remainingSeconds: Int,
    photoIndex: Int,
    totalPhotos: Int
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.7f)),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "$remainingSeconds",
                style = MaterialTheme.typography.displayLarge,
                fontSize = 120.sp,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Photo $photoIndex of $totalPhotos",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

/**
 * Error message banner with dismiss button.
 */
@Composable
private fun ErrorMessage(
    message: String,
    onDismiss: () -> Unit
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
                    text = "⚠️ Error",
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
                Spacer(modifier = Modifier.height(16.dp))
                Button(onClick = onDismiss) {
                    Text("Try Again")
                }
            }
        }
    }
}
