package com.jc.photobooth

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.jc.photobooth.model.PhotoData

@Composable
actual fun PhotoboothScreenWrapper(
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit
) {
    Text("Photobooth not supported on web Wasm yet")
}
