package com.jc.photobooth.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.dp
import com.jc.photobooth.data.SettingsRepository
import com.jc.photobooth.model.PhotoboothConfig
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    repository: SettingsRepository,
    onBack: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf(PhotoboothConfig()) }
    var isSaving by remember { mutableStateOf(false) }
    var kioskModeEnabled by remember { mutableStateOf(false) }
    var photoStripCountdown by remember { mutableStateOf(10) }

    LaunchedEffect(Unit) {
        repository.getConfig().collect { loadedConfig ->
            config = loadedConfig
        }
    }

    LaunchedEffect(Unit) {
        repository.getKioskModeEnabled().collect { enabled ->
            kioskModeEnabled = enabled
        }
    }

    LaunchedEffect(Unit) {
        repository.getPhotoStripCountdownSeconds().collect { seconds ->
            photoStripCountdown = seconds
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .padding(paddingValues)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(32.dp)
        ) {
            // Number of Photos Setting
            SettingSlider(
                label = "Number of Photos",
                value = config.numberOfPhotos,
                valueRange = 1f..10f,
                steps = 8,
                onValueChange = { newValue ->
                    config = config.copy(numberOfPhotos = newValue.toInt())
                    scope.launch {
                        isSaving = true
                        repository.saveConfig(config)
                        isSaving = false
                    }
                }
            )

            // Countdown Seconds Setting
            SettingSlider(
                label = "Countdown Seconds",
                value = config.countdownSeconds,
                valueRange = 1f..10f,
                steps = 8,
                onValueChange = { newValue ->
                    config = config.copy(countdownSeconds = newValue.toInt())
                    scope.launch {
                        isSaving = true
                        repository.saveConfig(config)
                        isSaving = false
                    }
                }
            )

            Divider()

            // Kiosk Mode Toggle
            SettingToggle(
                label = "Enable Kiosk Mode",
                description = "Hides system bars and blocks back button. Swipe from edge to temporarily show system bars.",
                checked = kioskModeEnabled,
                onCheckedChange = { enabled ->
                    kioskModeEnabled = enabled
                    scope.launch {
                        isSaving = true
                        repository.setKioskModeEnabled(enabled)
                        isSaving = false
                    }
                }
            )

            // Photo Strip Display Time
            SettingSlider(
                label = "Photo Strip Display Time",
                value = photoStripCountdown,
                valueRange = 5f..30f,
                steps = 24,
                onValueChange = { newValue ->
                    photoStripCountdown = newValue.toInt()
                    scope.launch {
                        isSaving = true
                        repository.setPhotoStripCountdownSeconds(newValue.toInt())
                        isSaving = false
                    }
                }
            )

            if (isSaving) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth()
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            // Info card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = Color(0xFF1A1A1A)
                ),
                shape = RectangleShape,
                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.2f))
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "Current Configuration",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                    Text(
                        text = "• ${config.numberOfPhotos} photos per session",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                    Text(
                        text = "• ${config.countdownSeconds} second countdown",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                    Text(
                        text = "• Kiosk mode: ${if (kioskModeEnabled) "Enabled" else "Disabled"}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                    Text(
                        text = "• Photo strip displays for $photoStripCountdown seconds",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingToggle(
    label: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onBackground
                )
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f)
                )
            }
            Switch(
                checked = checked,
                onCheckedChange = onCheckedChange
            )
        }
    }
}

@Composable
private fun SettingSlider(
    label: String,
    value: Int,
    valueRange: ClosedFloatingPointRange<Float>,
    steps: Int,
    onValueChange: (Float) -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onBackground
            )
            Text(
                text = value.toString(),
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.primary
            )
        }

        Slider(
            value = value.toFloat(),
            onValueChange = onValueChange,
            valueRange = valueRange,
            steps = steps,
            modifier = Modifier.fillMaxWidth()
        )
    }
}
