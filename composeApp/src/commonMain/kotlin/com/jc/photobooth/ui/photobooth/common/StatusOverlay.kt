package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Status overlay for photobooth screens.
 *
 * Displays a status message with icon and progress indicator.
 * Used for "Capturing...", "Downloading...", etc. states.
 *
 * @param icon Emoji or icon to display (e.g., "📸", "📥")
 * @param message Status message to display
 * @param showProgress Whether to show circular progress indicator
 * @param backgroundColor Background overlay color
 */
@Composable
fun StatusOverlay(
    icon: String,
    message: String,
    showProgress: Boolean = true,
    backgroundColor: Color = Color.Black.copy(alpha = 0.5f),
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
                text = icon,
                fontSize = 64.sp
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = message,
                color = Color.White,
                style = MaterialTheme.typography.headlineSmall
            )
            if (showProgress) {
                Spacer(modifier = Modifier.height(16.dp))
                CircularProgressIndicator(color = Color.White)
            }
        }
    }
}
