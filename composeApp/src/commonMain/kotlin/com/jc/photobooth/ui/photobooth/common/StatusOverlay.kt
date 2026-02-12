package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

/**
 * Status overlay for photobooth screens.
 *
 * Displays a status message with optional icon and progress indicator.
 * Used for "Capturing...", "Downloading...", etc. states.
 *
 * No background - text floats over clear live view with shadow for readability.
 *
 * @param icon Optional Material icon to display
 * @param message Status message to display
 * @param showProgress Whether to show circular progress indicator
 */
@Composable
fun StatusOverlay(
    icon: ImageVector? = null,
    message: String,
    showProgress: Boolean = true,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (icon != null) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    modifier = Modifier.size(64.dp),
                    tint = Color.White
                )
                Spacer(modifier = Modifier.height(16.dp))
            }
            Text(
                text = message,
                color = Color.White,
                style = MaterialTheme.typography.headlineSmall.copy(
                    shadow = Shadow(
                        color = Color.Black.copy(alpha = 0.8f),
                        blurRadius = 4f
                    )
                )
            )
            if (showProgress) {
                Spacer(modifier = Modifier.height(16.dp))
                CircularProgressIndicator(color = Color.White)
            }
        }
    }
}
