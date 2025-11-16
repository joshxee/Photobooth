package com.jc.photobooth

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.jc.photobooth.camera.createCameraController
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.permissions.PermissionState
import com.jc.photobooth.permissions.createCameraPermissionHandler
import com.jc.photobooth.ui.photobooth.PhotoboothScreen
import com.jc.photobooth.ui.photobooth.PhotoboothViewModel

@Composable
actual fun PhotoboothScreenWrapper(
    onNavigateToPhotoStrip: (List<PhotoData>) -> Unit,
    onNavigateHome: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = ContextCompat.getMainExecutor(context)

    val permissionHandler = remember {
        createCameraPermissionHandler(context)
    }

    val cameraController = remember {
        createCameraController(context, lifecycleOwner, executor)
    }

    val viewModel: PhotoboothViewModel = viewModel {
        PhotoboothViewModel(
            permissionHandler = permissionHandler,
            cameraController = cameraController,
            config = PhotoboothConfig()
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        val newState = if (isGranted) {
            PermissionState.GRANTED
        } else {
            // Check if we should show rationale
            if (permissionHandler is com.jc.photobooth.permissions.AndroidCameraPermissionHandler) {
                // This would need additional logic to detect permanent denial
                PermissionState.DENIED
            } else {
                PermissionState.DENIED
            }
        }
        viewModel.updatePermissionState(newState)
    }

    PhotoboothScreen(
        viewModel = viewModel,
        cameraController = cameraController,
        onNavigateToPhotoStrip = onNavigateToPhotoStrip,
        onNavigateHome = onNavigateHome,
        onRequestPermission = {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    )
}
