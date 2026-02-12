package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Gesture instruction overlay for photobooth screens.
 *
 * Displays palm emoji and instruction text in bottom-left corner
 * to inform users about gesture control feature.
 *
 * Only visible when idle and connected to camera.
 *
 * @param isVisible Whether the instructions are currently visible
 */
@Composable
fun GestureInstructionOverlay(
    isVisible: Boolean,
    modifier: Modifier = Modifier
) {
    if (!isVisible) return

    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(start = 20.dp, bottom = 136.dp), // Above button (56dp) + button padding (48dp) + spacing (32dp)
        contentAlignment = Alignment.BottomStart
    ) {
        Row(
            modifier = Modifier
                .shadow(4.dp, RoundedCornerShape(8.dp))
                .background(
                    color = Color.Black.copy(alpha = 0.7f),
                    shape = RoundedCornerShape(8.dp)
                )
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Palm emoji
            Text(
                text = "✋",
                fontSize = 32.sp,
                color = Color.White
            )
            // Instruction text
            Text(
                text = "Raise your open palm to start",
                style = MaterialTheme.typography.bodyLarge,
                color = Color.White
            )
        }
    }
}
