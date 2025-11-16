package com.jc.photobooth

import androidx.compose.runtime.Composable
import com.jc.photobooth.model.PhotoData

@Composable
expect fun PhotoboothScreenWrapper(
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit
)
