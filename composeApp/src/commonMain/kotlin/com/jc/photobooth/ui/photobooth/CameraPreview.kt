package com.jc.photobooth.ui.photobooth

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.jc.photobooth.camera.CameraController

@Composable
expect fun CameraPreview(controller: CameraController, modifier: Modifier)
