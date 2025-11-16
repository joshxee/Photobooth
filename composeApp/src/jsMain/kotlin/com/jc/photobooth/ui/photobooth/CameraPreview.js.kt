package com.jc.photobooth.ui.photobooth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.jc.photobooth.camera.CameraController

@Composable
actual fun CameraPreview(controller: CameraController, modifier: Modifier) {
    Box(modifier = modifier.background(MaterialTheme.colorScheme.surface), contentAlignment = Alignment.Center) {
        Text("Camera preview not available on web")
    }
}
