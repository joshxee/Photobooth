package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.jc.photobooth.ui.photobooth.strategy.PhotoboothContentStrategy

/**
 * Unified photobooth screen layout.
 *
 * Single source of truth for photobooth screen structure - all camera types
 * (Native, Sony Mark 1.1, Sony Mark 2.0) use this layout with different strategies.
 *
 * Layout structure (z-index from back to front):
 * 1. Camera content (background) - via strategy.CameraContent()
 * 2. State overlays (countdown, status, errors) - via strategy.StateOverlays()
 * 3. Home button (top-left) - shared HomeButton component
 * 4. Top-right content (badges/settings) - via strategy.TopRightContent()
 * 5. Action buttons (bottom-center) - via strategy.ActionButtons()
 *
 * **Why this works:**
 * - Eliminates UI duplication across 3 photobooth screens
 * - Future UX changes propagate automatically to all cameras
 * - Easy to add new camera types (just implement strategy)
 * - Preserves existing ViewModels (low risk refactoring)
 *
 * @param contentStrategy Camera-specific rendering strategy
 * @param captureState Current capture state (type depends on strategy)
 * @param onHomeClick Callback when home button is clicked
 * @param onCaptureClick Callback when capture/start button is clicked
 * @param onErrorDismiss Optional callback when error is dismissed (for strategies that need it)
 * @param modifier Optional modifier (typically Modifier.fillMaxSize())
 */
@Composable
fun PhotoboothLayout(
    contentStrategy: PhotoboothContentStrategy,
    captureState: Any,
    onHomeClick: () -> Unit,
    onCaptureClick: () -> Unit,
    onErrorDismiss: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize()) {
        // Layer 1: Camera preview/live view background
        contentStrategy.CameraContent(modifier = Modifier.fillMaxSize())

        // Layer 2: State-specific overlays (countdown, errors, status)
        contentStrategy.StateOverlays(
            captureState = captureState,
            onErrorDismiss = onErrorDismiss,
            modifier = Modifier.fillMaxSize()
        )

        // Layer 3: Home button (fixed top-left)
        HomeButton(
            onClick = onHomeClick,
            modifier = Modifier.align(Alignment.TopStart)
        )

        // Layer 4: Optional top-right content (badges, settings)
        contentStrategy.TopRightContent(
            modifier = Modifier.align(Alignment.TopEnd)
        )

        // Layer 5: Action buttons (fixed bottom-center)
        contentStrategy.ActionButtons(
            captureState = captureState,
            onCaptureClick = onCaptureClick,
            modifier = Modifier.align(Alignment.BottomCenter)
        )
    }
}
