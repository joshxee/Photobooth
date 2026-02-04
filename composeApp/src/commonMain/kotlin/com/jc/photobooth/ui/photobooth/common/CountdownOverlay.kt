package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Countdown overlay for photobooth capture sequence.
 *
 * Displays a large countdown number (3...2...1) and photo progress indicator.
 * Extracted from duplicated code in PhotoboothScreen, SonyPhotoboothScreen, and SonyMark2Screen.
 *
 * @param remainingSeconds Countdown value (e.g., 3, 2, 1)
 * @param photoIndex Current photo number (1-indexed)
 * @param totalPhotos Total number of photos in sequence
 * @param textColor Color for countdown text and photo index
 * @param backgroundColor Color for semi-transparent overlay background
 */
@Composable
fun CountdownOverlay(
    remainingSeconds: Int,
    photoIndex: Int,
    totalPhotos: Int,
    textColor: Color = MaterialTheme.colorScheme.onSurface,
    backgroundColor: Color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(backgroundColor),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "$remainingSeconds",
                style = MaterialTheme.typography.displayLarge,
                color = textColor
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Photo $photoIndex of $totalPhotos",
                style = MaterialTheme.typography.headlineMedium,
                color = textColor
            )
        }
    }
}
