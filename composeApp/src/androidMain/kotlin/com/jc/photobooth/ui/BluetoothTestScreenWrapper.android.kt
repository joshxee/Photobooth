package com.jc.photobooth.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.jc.photobooth.camera.AndroidBluetoothCameraController

@Composable
actual fun BluetoothTestScreenWrapper(onBack: () -> Unit) {
    val context = LocalContext.current
    val controller = remember { AndroidBluetoothCameraController(context) }

    DisposableEffect(Unit) {
        onDispose {
            controller.release()
        }
    }

    BluetoothTestScreen(
        controller = controller,
        onBack = onBack
    )
}
