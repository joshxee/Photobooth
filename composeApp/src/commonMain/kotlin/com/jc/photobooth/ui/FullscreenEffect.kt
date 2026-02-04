package com.jc.photobooth.ui

import androidx.compose.runtime.Composable

/**
 * Enters fullscreen/immersive mode when this composable is active.
 * Automatically exits fullscreen when this composable is disposed.
 *
 * On Android: Hides system bars (notification bar and navigation controls)
 * On other platforms: No-op
 */
@Composable
expect fun FullscreenEffect()
