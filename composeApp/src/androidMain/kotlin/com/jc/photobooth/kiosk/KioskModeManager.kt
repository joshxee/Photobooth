package com.jc.photobooth.kiosk

import android.app.Activity
import android.view.View
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Android implementation of KioskModeManager using Immersive Sticky Mode.
 *
 * This implementation:
 * - Hides system bars (navigation and status bars)
 * - Uses BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE (bars temporarily visible on swipe)
 * - Re-applies immersive mode when window regains focus
 * - Does NOT require device owner or special provisioning
 *
 * Limitations:
 * - Users can still swipe from edge to temporarily show system bars
 * - Back button must be blocked separately (in Activity)
 * - Not as secure as Lock Task Mode, but much easier to set up
 */
actual class KioskModeManager(
    private val activity: Activity
) {
    private val _isKioskModeEnabled = MutableStateFlow(false)
    actual val isKioskModeEnabled: StateFlow<Boolean> = _isKioskModeEnabled.asStateFlow()

    /**
     * Enable Immersive Sticky Mode to hide system bars.
     */
    actual suspend fun enableKioskMode(): Result<Unit> {
        return try {
            // Run on main thread
            activity.runOnUiThread {
                val window = activity.window
                val decorView = window.decorView

                // Make system bars draw behind the app content
                WindowCompat.setDecorFitsSystemWindows(window, false)

                // Get the window insets controller
                val insetsController = WindowInsetsControllerCompat(window, decorView)

                // Hide both status and navigation bars
                insetsController.hide(WindowInsetsCompat.Type.systemBars())

                // Set behavior: bars will temporarily appear on swipe and auto-hide
                insetsController.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

                // Additional: Set fullscreen flag for older Android versions
                @Suppress("DEPRECATION")
                decorView.systemUiVisibility = (
                    android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                    or android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
            }

            _isKioskModeEnabled.value = true
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Disable Immersive Mode and restore system bars.
     */
    actual suspend fun disableKioskMode(): Result<Unit> {
        return try {
            val window = activity.window
            val decorView = window.decorView

            // Restore system bars drawing
            WindowCompat.setDecorFitsSystemWindows(window, true)

            // Show system bars
            val insetsController = WindowInsetsControllerCompat(window, decorView)
            insetsController.show(WindowInsetsCompat.Type.systemBars())

            _isKioskModeEnabled.value = false
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Re-apply immersive mode when window regains focus.
     * Should be called from Activity.onWindowFocusChanged(hasFocus: Boolean) or onResume().
     */
    suspend fun reapplyImmersiveMode() {
        if (_isKioskModeEnabled.value) {
            enableKioskMode()
        }
    }

    /**
     * Synchronously apply immersive mode (for immediate application on startup).
     * Use this when you need to apply kiosk mode before async flows complete.
     */
    fun enableKioskModeSync() {
        try {
            val window = activity.window
            val decorView = window.decorView

            WindowCompat.setDecorFitsSystemWindows(window, false)
            val insetsController = WindowInsetsControllerCompat(window, decorView)
            insetsController.hide(WindowInsetsCompat.Type.systemBars())
            insetsController.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

            @Suppress("DEPRECATION")
            decorView.systemUiVisibility = (
                android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                or android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )

            _isKioskModeEnabled.value = true
        } catch (e: Exception) {
            // Ignore errors
        }
    }
}
