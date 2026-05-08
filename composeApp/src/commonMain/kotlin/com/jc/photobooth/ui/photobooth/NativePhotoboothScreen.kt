package com.jc.photobooth.ui.photobooth

import androidx.compose.runtime.Composable
import com.jc.photobooth.data.SettingsRepository

/**
 * Native (device-camera) photobooth screen.
 * Each platform supplies its own camera bootstrap; the shared flow lives in
 * [PhotoboothHost].
 */
@Composable
expect fun NativePhotoboothScreen(
    settingsRepository: SettingsRepository,
    onHome: () -> Unit,
    onOpenSettings: () -> Unit,
    headline: String = "Sarah & Tom's Wedding",
    totalShots: Int = 3
)
