package com.jc.photobooth.ui

import android.app.Activity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Android implementation: Enters immersive fullscreen mode.
 */
@Composable
actual fun FullscreenEffect() {
    val view = LocalView.current
    val context = LocalContext.current

    DisposableEffect(Unit) {
        // Enter fullscreen when this composable enters composition
        val window = (context as? Activity)?.window
        if (window != null) {
            val decorView = window.decorView

            // Hide system bars
            WindowCompat.setDecorFitsSystemWindows(window, false)
            val insetsController = WindowInsetsControllerCompat(window, decorView)
            insetsController.hide(WindowInsetsCompat.Type.systemBars())
            insetsController.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

            // Additional flags for older Android versions
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

        onDispose {
            // Exit fullscreen when this composable leaves composition
            if (window != null) {
                WindowCompat.setDecorFitsSystemWindows(window, true)
                val insetsController = WindowInsetsControllerCompat(window, window.decorView)
                insetsController.show(WindowInsetsCompat.Type.systemBars())

                // Clear deprecated flags
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = 0
            }
        }
    }
}
