package com.jc.photobooth

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData

@Composable
actual fun PhotoboothScreenWrapper(
    settingsRepository: SettingsRepository,
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit,
    onOpenSettings: () -> Unit
) {
    Text("Photobooth not supported on desktop yet")
}
