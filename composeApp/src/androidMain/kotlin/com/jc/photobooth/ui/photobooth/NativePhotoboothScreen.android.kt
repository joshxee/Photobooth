package com.jc.photobooth.ui.photobooth

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
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
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.jc.photobooth.camera.createCameraController
import com.jc.photobooth.data.SettingsRepository
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

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted -> hasPermission = granted }

    LaunchedEffect(Unit) {
        if (!hasPermission) launcher.launch(Manifest.permission.CAMERA)
    }

    if (!hasPermission) {
        PermissionPrompt(onRequest = { launcher.launch(Manifest.permission.CAMERA) })
        return
    }

    val controller = remember { createCameraController(context, lifecycleOwner, executor) }

    PhotoboothHost(
        headline = headline,
        totalShots = totalShots,
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
private fun PermissionPrompt(onRequest: () -> Unit) {
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
                text = "Photobooth needs the camera to run live preview and capture strips.",
                color = KnockboxTokens.Paper.copy(alpha = 0.7f),
                fontFamily = KnockboxFonts.Sans,
                fontSize = 14.sp
            )
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(KnockboxTokens.Paper)
                    .clickable { onRequest() }
                    .padding(horizontal = 28.dp, vertical = 14.dp)
            ) {
                Text(
                    text = "Grant camera",
                    color = KnockboxTokens.Ink,
                    fontFamily = KnockboxFonts.Sans,
                    fontWeight = FontWeight.Medium,
                    fontSize = 16.sp
                )
            }
        }
    }
}
