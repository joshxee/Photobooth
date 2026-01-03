package com.jc.photobooth.camera.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.domain.CameraRepository
import com.jc.photobooth.camera.domain.CameraType
import com.jc.photobooth.camera.domain.ConnectionState
import com.jc.photobooth.camera.domain.PhotoboothCamera
import com.jc.photobooth.camera.domain.WiFiConnectionManager
import kotlinx.coroutines.launch

@Composable
fun CameraPreviewScreen(
    repository: CameraRepository,
    onBack: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var camera by remember { mutableStateOf<PhotoboothCamera?>(null) }
    var cameraType by remember { mutableStateOf<CameraType?>(null) }
    var connectionState by remember { mutableStateOf<ConnectionState>(ConnectionState.Disconnected) }
    var liveViewFrame by remember { mutableStateOf<ImageBitmap?>(null) }
    var capturedPhoto by remember { mutableStateOf<ImageBitmap?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var isCapturing by remember { mutableStateOf(false) }

    // Initialize camera
    LaunchedEffect(Unit) {
        repository.selectedCameraType.collect { type ->
            cameraType = type
            camera = repository.getCameraInstance(type)

            // Collect connection state
            camera?.connectionState?.collect { state ->
                connectionState = state
            }
        }
    }

    // Collect live view frames
    LaunchedEffect(camera) {
        camera?.liveViewFrame?.collect { frame ->
            liveViewFrame = frame
        }
    }

    // Auto-connect when screen opens
    LaunchedEffect(camera) {
        camera?.let { cam ->
            if (connectionState is ConnectionState.Disconnected) {
                val result = cam.connect()
                if (result.isSuccess) {
                    // Auto-start live view
                    val liveViewResult = cam.startLiveView()
                    if (liveViewResult.isFailure) {
                        errorMessage = "Live view start failed: ${liveViewResult.exceptionOrNull()?.message}"
                    }
                } else {
                    errorMessage = result.exceptionOrNull()?.message
                }
            }
        }
    }

    // Cleanup when leaving screen
    DisposableEffect(Unit) {
        onDispose {
            scope.launch {
                camera?.stopLiveView()
                camera?.disconnect()
            }
        }
    }

    Box(
        modifier = Modifier
            .background(MaterialTheme.colorScheme.background)
            .fillMaxSize()
            .safeContentPadding()
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Header
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.surface,
                shadowElevation = 4.dp
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    TextButton(onClick = onBack) {
                        Text("< Back")
                    }

                    Text(
                        text = cameraType?.displayName ?: "Camera",
                        style = MaterialTheme.typography.titleMedium
                    )

                    ConnectionStatusIndicator(connectionState)
                }
            }

            // Main content
            if (capturedPhoto != null) {
                // Show captured photo
                CapturedPhotoView(
                    photo = capturedPhoto!!,
                    onRetake = {
                        capturedPhoto = null
                        scope.launch {
                            camera?.startLiveView()
                        }
                    },
                    onSave = {
                        // TODO: Implement save functionality
                        capturedPhoto = null
                        onBack()
                    }
                )
            } else {
                // Show live view
                LiveViewPreview(
                    liveViewFrame = liveViewFrame,
                    connectionState = connectionState,
                    errorMessage = errorMessage,
                    modifier = Modifier.weight(1f)
                )

                // Capture button
                CaptureButton(
                    enabled = connectionState is ConnectionState.Connected && !isCapturing,
                    isCapturing = isCapturing,
                    onClick = {
                        scope.launch {
                            isCapturing = true
                            errorMessage = null

                            camera?.let { cam ->
                                println("DEBUG UI: Capture button pressed")
                                // Stop live view before capture
                                cam.stopLiveView()
                                println("DEBUG UI: Live view stopped, starting capture")

                                val result = cam.capture()
                                if (result.isSuccess) {
                                    println("DEBUG UI: Capture SUCCESS")
                                    capturedPhoto = result.getOrNull()?.image
                                } else {
                                    println("DEBUG UI: Capture FAILED: ${result.exceptionOrNull()}")
                                    errorMessage = result.exceptionOrNull()?.message
                                    // Restart live view on error
                                    cam.startLiveView()
                                }
                            }

                            isCapturing = false
                        }
                    },
                    modifier = Modifier.padding(32.dp)
                )
            }
        }
    }
}

@Composable
fun LiveViewPreview(
    liveViewFrame: ImageBitmap?,
    connectionState: ConnectionState,
    errorMessage: String?,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(Color.Black),
        contentAlignment = Alignment.Center
    ) {
        when {
            liveViewFrame != null -> {
                Image(
                    bitmap = liveViewFrame,
                    contentDescription = "Live view",
                    modifier = Modifier.fillMaxSize()
                )
            }
            connectionState is ConnectionState.Connecting -> {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(color = Color.White)
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = "Connecting to camera...",
                        color = Color.White,
                        style = MaterialTheme.typography.bodyLarge
                    )
                }
            }
            connectionState is ConnectionState.Error || errorMessage != null -> {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.padding(24.dp)
                ) {
                    Text(
                        text = "⚠️",
                        style = MaterialTheme.typography.displayLarge
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = errorMessage ?: (connectionState as? ConnectionState.Error)?.message ?: "Unknown error",
                        color = Color.White,
                        style = MaterialTheme.typography.bodyLarge,
                        textAlign = TextAlign.Center
                    )
                }
            }
            else -> {
                Text(
                    text = "Waiting for camera...",
                    color = Color.White,
                    style = MaterialTheme.typography.bodyLarge
                )
            }
        }
    }
}

@Composable
fun CaptureButton(
    enabled: Boolean,
    isCapturing: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Button(
        onClick = onClick,
        enabled = enabled && !isCapturing,
        modifier = modifier.size(80.dp),
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary
        )
    ) {
        if (isCapturing) {
            CircularProgressIndicator(
                modifier = Modifier.size(32.dp),
                color = MaterialTheme.colorScheme.onPrimary
            )
        } else {
            Text(
                text = "📷",
                style = MaterialTheme.typography.displaySmall
            )
        }
    }
}

@Composable
fun ConnectionStatusIndicator(state: ConnectionState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .background(
                    color = when (state) {
                        is ConnectionState.Connected -> Color.Green
                        is ConnectionState.Connecting -> Color.Yellow
                        is ConnectionState.Error -> Color.Red
                        is ConnectionState.Disconnected -> Color.Gray
                    },
                    shape = CircleShape
                )
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = when (state) {
                is ConnectionState.Connected -> "Connected"
                is ConnectionState.Connecting -> "Connecting"
                is ConnectionState.Error -> "Error"
                is ConnectionState.Disconnected -> "Disconnected"
            },
            style = MaterialTheme.typography.bodySmall
        )
    }
}

@Composable
fun CapturedPhotoView(
    photo: ImageBitmap,
    onRetake: () -> Unit,
    onSave: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // Photo preview
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(Color.Black),
            contentAlignment = Alignment.Center
        ) {
            Image(
                bitmap = photo,
                contentDescription = "Captured photo",
                modifier = Modifier.fillMaxSize()
            )
        }

        // Action buttons
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            OutlinedButton(
                onClick = onRetake,
                modifier = Modifier.weight(1f)
            ) {
                Text("Retake")
            }

            Button(
                onClick = onSave,
                modifier = Modifier.weight(1f)
            ) {
                Text("Save")
            }
        }
    }
}
