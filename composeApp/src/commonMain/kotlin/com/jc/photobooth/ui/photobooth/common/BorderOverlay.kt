package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Border overlay for photobooth capture.
 *
 * Displays a white border around the live view to indicate photo is being taken.
 * Subtle visual feedback without obscuring the view.
 *
 * @param isVisible Whether the border is currently visible
 */
@Composable
fun BorderOverlay(
    isVisible: Boolean,
    modifier: Modifier = Modifier
) {
    if (isVisible) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .border(width = 8.dp, color = Color.White)
        )
    }
}
