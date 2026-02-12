package com.jc.photobooth.ui.photostrip

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.model.toImageBitmap
import com.jc.photobooth.ui.FullscreenEffect

/**
 * Photo strip screen with automatic countdown to return to live view.
 *
 * Stays in fullscreen/immersive mode for continuous photobooth experience.
 *
 * @param photos List of captured photos to display
 * @param countdownDurationSeconds Duration of countdown before auto-return (default: 10 seconds)
 * @param onReturnToLiveView Callback to return directly to Sony Mark 2.0 live view
 * @param onReturnToPhotobooth Callback to return to camera selection screen
 */
@Composable
fun PhotoStripScreen(
    photos: List<PhotoData>,
    countdownDurationSeconds: Int = 10,
    onReturnToLiveView: (() -> Unit)? = null,
    onReturnToPhotobooth: () -> Unit
) {
    // Stay in fullscreen mode during photo strip display
    FullscreenEffect()

    val viewModel = remember {
        PhotoStripViewModel(countdownDurationSeconds = countdownDurationSeconds)
    }
    val uiState by viewModel.uiState.collectAsState()

    // Set photos when screen loads
    LaunchedEffect(photos) {
        viewModel.setPhotos(photos)
    }

    // Set completion callback - prefer returning to live view if provided
    LaunchedEffect(onReturnToLiveView, onReturnToPhotobooth) {
        viewModel.onCountdownComplete = {
            // Clear photos from memory before navigation
            viewModel.clearPhotos()
            onReturnToLiveView?.invoke() ?: onReturnToPhotobooth()
        }
        viewModel.startCountdown()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // Center: Photo strip
        PhotoStripComponent(
            photos = photos,
            modifier = Modifier.align(Alignment.Center)
        )

        // Top-right: Countdown timer
        if (uiState.isCountdownActive) {
            CircularCountdownTimer(
                durationSeconds = uiState.countdownSeconds,
                onComplete = {
                    onReturnToLiveView?.invoke() ?: onReturnToPhotobooth()
                },
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(24.dp)
                    .clickable {
                        viewModel.skipCountdown()
                    }
            )
        }

        // Bottom-right: Button
        OutlinedButton(
            onClick = { viewModel.skipCountdown() },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(24.dp),
            border = BorderStroke(1.dp, Color.White),
            shape = RectangleShape
        ) {
            Text(
                text = "Take Another Photostrip",
                style = MaterialTheme.typography.titleMedium,
                color = Color.White
            )
        }

        // Left side: Wedding message
        Text(
            text = "the photos will be edited and\nshared by sarah after the wedding.",
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White,
            textAlign = TextAlign.Start,
            modifier = Modifier
                .align(Alignment.CenterStart)
                .padding(start = 32.dp, end = 32.dp)
                .widthIn(max = 200.dp)
        )
    }
}

/**
 * Realistic photo booth strip component with white background and borders.
 *
 * Creates authentic photostrip appearance:
 * - White background
 * - White borders around entire strip (via padding)
 * - White borders between photos (via spacing)
 * - 3 photos vertically arranged
 * - Fixed width for consistent proportions
 */
@Composable
fun PhotoStripComponent(
    photos: List<PhotoData>,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .width(320.dp)
            .background(Color.White)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        photos.forEach { photo ->
            PhotoItem(
                photoData = photo,
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(4f / 3f)
            )
        }
    }
}

@Composable
fun PhotoItem(photoData: PhotoData, modifier: Modifier = Modifier) {
    val imageBitmap = remember(photoData) {
        photoData.toImageBitmap()
    }

    Image(
        bitmap = imageBitmap,
        contentDescription = "Photo",
        modifier = modifier.graphicsLayer { scaleX = -1f },
        contentScale = ContentScale.Fit
    )
}
