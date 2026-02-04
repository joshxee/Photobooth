package com.jc.photobooth.kiosk

import kotlinx.coroutines.flow.StateFlow

/**
 * Platform-specific manager for kiosk mode functionality.
 *
 * Kiosk mode prevents users from accidentally leaving the app by:
 * - Hiding system bars (navigation and status bars)
 * - Blocking back button navigation
 * - Keeping screen on continuously
 *
 * On Android, this uses Immersive Sticky Mode which:
 * - Hides system bars automatically
 * - Temporarily shows bars on edge swipe (they auto-hide)
 * - Does not require special device provisioning
 */
expect class KioskModeManager {
    /**
     * StateFlow indicating whether kiosk mode is currently enabled.
     */
    val isKioskModeEnabled: StateFlow<Boolean>

    /**
     * Enable kiosk mode.
     *
     * On Android: Enables Immersive Sticky Mode
     * On other platforms: May have limited or no effect
     *
     * @return Result.success if enabled successfully, Result.failure otherwise
     */
    suspend fun enableKioskMode(): Result<Unit>

    /**
     * Disable kiosk mode and restore normal UI.
     *
     * @return Result.success if disabled successfully, Result.failure otherwise
     */
    suspend fun disableKioskMode(): Result<Unit>
}
