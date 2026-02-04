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
import androidx.compose.ui.layout.ContentScale
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
            .background(MaterialTheme.colorScheme.background)
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "Your Photo Strip",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Photo strip layout
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                photos.forEach { photo ->
                    PhotoItem(
                        photoData = photo,
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f)
                    )
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            // Manual "Take Another" button (secondary option)
            OutlinedButton(
                onClick = {
                    viewModel.skipCountdown()
                },
                modifier = Modifier.fillMaxWidth(),
                border = BorderStroke(1.dp, Color.White),
                shape = RectangleShape
            ) {
                Text("Take Another Photo Strip", color = Color.White)
            }
        }

        // Circular countdown timer in bottom-right corner
        if (uiState.isCountdownActive) {
            CircularCountdownTimer(
                durationSeconds = uiState.countdownSeconds,
                onComplete = {
                    onReturnToLiveView?.invoke() ?: onReturnToPhotobooth()
                },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(24.dp)
                    .clickable {
                        // Tap to skip countdown and return immediately
                        viewModel.skipCountdown()
                    }
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
        modifier = modifier,
        contentScale = ContentScale.Crop
    )
}
