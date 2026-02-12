package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Countdown overlay for photobooth capture sequence.
 *
 * Displays a large countdown number (3...2...1) and photo progress indicator.
 * Extracted from duplicated code in PhotoboothScreen, SonyPhotoboothScreen, and SonyMark2Screen.
 *
 * No background - text floats over clear live view with shadow for readability.
 *
 * @param remainingSeconds Countdown value (e.g., 3, 2, 1)
 * @param photoIndex Current photo number (1-indexed)
 * @param totalPhotos Total number of photos in sequence
 * @param textColor Color for countdown text and photo index
 */
@Composable
fun CountdownOverlay(
    remainingSeconds: Int,
    photoIndex: Int,
    totalPhotos: Int,
    textColor: Color = Color.White,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            // Contextual message (only at 2 and 1, not at 3)
            val message = when (remainingSeconds) {
                2, 1 -> "Look at the camera!"
                else -> null
            }
            if (message != null) {
                Text(
                    text = message,
                    style = MaterialTheme.typography.headlineLarge.copy(
                        shadow = Shadow(
                            color = Color.Black.copy(alpha = 0.8f),
                            blurRadius = 4f
                        )
                    ),
                    color = textColor
                )
                Spacer(modifier = Modifier.height(8.dp))
            }
            // Large countdown number
            Text(
                text = "$remainingSeconds",
                style = MaterialTheme.typography.displayLarge.copy(
                    shadow = Shadow(
                        color = Color.Black.copy(alpha = 0.8f),
                        blurRadius = 8f
                    )
                ),
                color = textColor,
                fontSize = 150.sp
            )
            Spacer(modifier = Modifier.height(8.dp))
            // Photo progress
            Text(
                text = "Photo $photoIndex of $totalPhotos",
                style = MaterialTheme.typography.titleLarge.copy(
                    shadow = Shadow(
                        color = Color.Black.copy(alpha = 0.8f),
                        blurRadius = 4f
                    )
                ),
                color = textColor
            )
        }
    }
}
