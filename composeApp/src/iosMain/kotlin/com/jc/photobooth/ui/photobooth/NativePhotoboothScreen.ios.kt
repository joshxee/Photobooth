package com.jc.photobooth.ui.photobooth

import androidx.compose.runtime.Composable
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.ui.knockbox.KnockboxFrame
import com.jc.photobooth.ui.knockbox.PlaceholderHues
import kotlinx.coroutines.delay

@Composable
actual fun NativePhotoboothScreen(
    settingsRepository: SettingsRepository,
    onHome: () -> Unit,
    onOpenSettings: () -> Unit,
    headline: String,
    totalShots: Int
) {
    PhotoboothHost(
        headline = headline,
        totalShots = totalShots,
        livePreview = {},
        captureFrame = { index ->
            delay(320)
            KnockboxFrame(
                hue = PlaceholderHues[index % PlaceholderHues.size],
                label = "guest 0${index + 1}"
            )
        }
    )
}
