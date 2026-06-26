package com.jc.photobooth.ui.photobooth

import android.view.ViewGroup
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.jc.photobooth.camera.AndroidCameraController
import com.jc.photobooth.camera.CameraController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@Composable
actual fun CameraPreview(
    controller: CameraController,
    modifier: Modifier
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val previewView = remember {
        PreviewView(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    DisposableEffect(controller) {
        CoroutineScope(Dispatchers.Main).launch {
            val androidController = controller as AndroidCameraController
            val preview = androidController.initialize()
            preview.setSurfaceProvider(previewView.surfaceProvider)
        }

        onDispose {
            controller.release()
        }
    }

    AndroidView(
        factory = { previewView },
        modifier = modifier.graphicsLayer { scaleX = -1f }
    )
}
