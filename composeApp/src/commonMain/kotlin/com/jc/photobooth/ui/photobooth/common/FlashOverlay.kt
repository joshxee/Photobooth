package com.jc.photobooth.ui.photobooth.common

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

/**
 * Flash overlay for photobooth capture.
 *
 * Displays a white flash effect synchronized with photo capture.
 * Simulates traditional camera flash.
 *
 * @param isVisible Whether the flash is currently visible
 */
@Composable
fun FlashOverlay(
    isVisible: Boolean,
    modifier: Modifier = Modifier
) {
    AnimatedVisibility(
        visible = isVisible,
        enter = fadeIn(animationSpec = tween(50)),
        exit = fadeOut(animationSpec = tween(100))
    ) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(Color.White)
        )
    }
}
