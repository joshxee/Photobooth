package com.jc.photobooth.ui.photobooth

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.core.app.ActivityCompat
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import androidx.core.content.ContextCompat
import com.jc.photobooth.camera.createCameraController
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.model.toImageBitmap
import com.jc.photobooth.ui.knockbox.KnockboxFonts
import com.jc.photobooth.ui.knockbox.KnockboxFrame
import com.jc.photobooth.ui.knockbox.KnockboxTokens
import com.jc.photobooth.ui.knockbox.PlaceholderHues

@Composable
actual fun NativePhotoboothScreen(
    settingsRepository: SettingsRepository,
    onHome: () -> Unit,
    onOpenSettings: () -> Unit,
    headline: String,
    totalShots: Int
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { ContextCompat.getMainExecutor(context) }

    var hasPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
        )
    }
    var permissionRequested by remember { mutableStateOf(false) }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasPermission = granted
        permissionRequested = true
    }

    LaunchedEffect(Unit) {
        if (!hasPermission) launcher.launch(Manifest.permission.CAMERA)
    }

    if (!hasPermission) {
        val activity = context as? Activity
        val canRequestAgain = activity?.let {
            ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.CAMERA)
        } ?: true
        val permanentlyDenied = permissionRequested && !canRequestAgain

        PermissionPrompt(
            permanentlyDenied = permanentlyDenied,
            onRequest = { launcher.launch(Manifest.permission.CAMERA) },
            onOpenSettings = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", context.packageName, null)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }
        )
        return
    }

    val controller = remember { createCameraController(context, lifecycleOwner, executor) }
    val config by settingsRepository.getConfig().collectAsState(initial = PhotoboothConfig())

    PhotoboothHost(
        headline = headline,
        totalShots = config.numberOfPhotos,
        countdownSeconds = config.countdownSeconds,
        livePreview = {
            CameraPreview(
                controller = controller,
                modifier = Modifier.fillMaxSize()
            )
        },
        captureFrame = { index ->
            val photo = controller.capturePhoto()
            KnockboxFrame(
                hue = PlaceholderHues[index % PlaceholderHues.size],
                label = "shot ${index + 1}",
                image = photo.toImageBitmap()
            )
        }
    )
}

@Composable
private fun PermissionPrompt(
    permanentlyDenied: Boolean,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(KnockboxTokens.Ink),
        contentAlignment = Alignment.Center
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp)
        ) {
            Text(
                text = "Camera access needed",
                color = KnockboxTokens.Paper,
                fontFamily = KnockboxFonts.Sans,
                fontSize = 28.sp,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = if (permanentlyDenied) {
                    "Camera access was denied. Enable it in system settings to continue."
                } else {
                    "Photobooth needs the camera to run live preview and capture strips."
                },
                color = KnockboxTokens.Paper.copy(alpha = 0.7f),
                fontFamily = KnockboxFonts.Sans,
                fontSize = 14.sp
            )
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(KnockboxTokens.Paper)
                    .clickable {
                        if (permanentlyDenied) onOpenSettings() else onRequest()
                    }
                    .padding(horizontal = 28.dp, vertical = 14.dp)
            ) {
                Text(
                    text = if (permanentlyDenied) "Open settings" else "Grant camera",
                    color = KnockboxTokens.Ink,
                    fontFamily = KnockboxFonts.Sans,
                    fontWeight = FontWeight.Medium,
                    fontSize = 16.sp
                )
            }
        }
    }
}
