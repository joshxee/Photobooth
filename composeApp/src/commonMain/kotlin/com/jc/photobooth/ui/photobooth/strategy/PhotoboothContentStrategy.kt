package com.jc.photobooth.ui.photobooth.strategy

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Strategy interface for camera-specific photobooth content rendering.
 *
 * Defines how different camera types (Native, Sony Mark 1.1, Sony Mark 2.0)
 * render their specific content within the unified PhotoboothLayout.
 *
 * All cameras share the same layout structure but differ in:
 * - Camera preview/live view rendering
 * - State-specific overlays (countdown, capturing, errors)
 * - Action buttons and their conditions
 * - Optional top-right content (badges, settings)
 */
interface PhotoboothContentStrategy {

    /**
     * Renders the camera preview/live view background.
     *
     * This is the base layer of the photobooth screen, typically showing:
     * - Native camera: CameraPreview composable
     * - Sony: Live view image or frozen frame
     *
     * @param modifier Typically Modifier.fillMaxSize()
     */
    @Composable
    fun CameraContent(modifier: Modifier = Modifier)

    /**
     * Renders state-specific overlays on top of camera content.
     *
     * This includes:
     * - Countdown overlays (using shared CountdownOverlay)
     * - Status messages (capturing, downloading, etc.)
     * - Error messages (using shared ErrorOverlay)
     *
     * @param captureState Generic state (cast to specific type within strategy)
     * @param onErrorDismiss Optional callback when error is dismissed
     * @param modifier Typically Modifier.fillMaxSize()
     */
    @Composable
    fun StateOverlays(
        captureState: Any,
        onErrorDismiss: (() -> Unit)? = null,
        modifier: Modifier = Modifier
    )

    /**
     * Renders action buttons (typically capture/start button at bottom center).
     *
     * Buttons are conditionally displayed based on capture state.
     *
     * @param captureState Generic state (cast to specific type within strategy)
     * @param onCaptureClick Callback when capture button is clicked
     * @param modifier Positioning modifier (typically align to BottomCenter)
     */
    @Composable
    fun ActionButtons(
        captureState: Any,
        onCaptureClick: () -> Unit,
        modifier: Modifier = Modifier
    )

    /**
     * Optional content for top-right corner.
     *
     * Examples:
     * - Settings button (Native camera)
     * - "Mark 2.0" badge (Sony Mark 2)
     * - Empty (Sony Mark 1.1)
     *
     * @param modifier Positioning modifier (typically align to TopEnd with padding)
     */
    @Composable
    fun TopRightContent(modifier: Modifier = Modifier) {
        // Default: empty (override if needed)
    }
}
