package com.jc.photobooth

import androidx.compose.runtime.Composable
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoData

@Composable
expect fun PhotoboothScreenWrapper(
    settingsRepository: SettingsRepository,
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit,
    onOpenSettings: () -> Unit
)
