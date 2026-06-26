package com.jc.photobooth.camera.ui.discovery

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.data.sony.CaptureWorkflowResult
import com.jc.photobooth.camera.data.sony.SonyCameraApiClient
import com.jc.photobooth.camera.data.sony.createPlatformLogger
import com.jc.photobooth.camera.domain.ConnectionState
import com.jc.photobooth.camera.domain.discovery.*
import com.jc.photobooth.camera.ui.ConnectionStatusIndicator
import com.jc.photobooth.data.createDataStore
import kotlinx.coroutines.launch

@Composable
fun SonyApiDiscoveryScreen(
    onBack: () -> Unit
) {
    val scope = rememberCoroutineScope()
    val apiClient = remember { SonyCameraApiClient(logger = createPlatformLogger()) }
    val discoveryService = remember { SonyApiDiscoveryService(apiClient) }

    var connectionState by remember { mutableStateOf<ConnectionState>(ConnectionState.Disconnected) }
    var availableApis by remember { mutableStateOf<List<ApiMethodInfo>>(emptyList()) }
    var testResults by remember { mutableStateOf<List<ApiTestResult>>(emptyList()) }
    var captureTestResults by remember { mutableStateOf<List<CaptureMethodResult>>(emptyList()) }
    var captureWorkflowResult by remember { mutableStateOf<CaptureWorkflowResult?>(null) }
    var eventAnalysis by remember { mutableStateOf<EventStructureAnalysis?>(null) }
    var sdCardCapabilities by remember { mutableStateOf<SdCardCapabilities?>(null) }
    var isDiscovering by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Auto-connect on screen entry
    LaunchedEffect(Unit) {
        connectionState = ConnectionState.Connecting
        try {
            val result = apiClient.getAvailableApiList()
            if (result.isSuccess) {
                connectionState = ConnectionState.Connected
                statusMessage = "Connected to camera"
            } else {
                connectionState = ConnectionState.Error(result.exceptionOrNull()?.message ?: "Connection failed")
                errorMessage = result.exceptionOrNull()?.message
            }
        } catch (e: Exception) {
            connectionState = ConnectionState.Error(e.message ?: "Connection failed")
            errorMessage = e.message
        }
    }

    // Cleanup on exit
    DisposableEffect(Unit) {
        onDispose {
            apiClient.close()
        }
    }

    Scaffold(
        topBar = {
            Surface(
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
                        text = "Sony API Discovery",
                        style = MaterialTheme.typography.titleMedium
                    )

                    ConnectionStatusIndicator(connectionState)
                }
            }
        }
    ) { paddingValues ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Status message
            if (statusMessage != null) {
                item {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.primaryContainer
                        )
                    ) {
                        Text(
                            text = statusMessage.orEmpty(),
                            modifier = Modifier.padding(16.dp),
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }

            // Error message
            if (errorMessage != null) {
                item {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer
                        )
                    ) {
                        Text(
                            text = "Error: $errorMessage",
                            modifier = Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }

            // Action buttons
            item {
                Card {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = "Discovery Actions",
                            style = MaterialTheme.typography.titleSmall,
                            modifier = Modifier.padding(bottom = 8.dp)
                        )

                        Button(
                            onClick = {
                                scope.launch {
                                    isDiscovering = true
                                    errorMessage = null
                                    statusMessage = "Discovering available APIs..."

                                    val result = discoveryService.discoverAvailableApis()
                                    if (result.isSuccess) {
                                        availableApis = result.getOrNull() ?: emptyList()
                                        statusMessage = "Found ${availableApis.size} API methods"
                                    } else {
                                        errorMessage = result.exceptionOrNull()?.message
                                    }

                                    isDiscovering = false
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = connectionState is ConnectionState.Connected && !isDiscovering
                        ) {
                            if (isDiscovering) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    color = MaterialTheme.colorScheme.onPrimary,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text("🔍 Discover Available APIs")
                        }

                        Button(
                            onClick = {
                                scope.launch {
                                    isDiscovering = true
                                    errorMessage = null
                                    statusMessage = "Testing capture methods..."

                                    val result = discoveryService.testCaptureVariants()
                                    if (result.isSuccess) {
                                        captureTestResults = result.getOrNull() ?: emptyList()
                                        statusMessage = "Tested ${captureTestResults.size} capture methods"
                                    } else {
                                        errorMessage = result.exceptionOrNull()?.message
                                    }

                                    isDiscovering = false
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = connectionState is ConnectionState.Connected && !isDiscovering
                        ) {
                            if (isDiscovering) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    color = MaterialTheme.colorScheme.onPrimary,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text("📸 Test Capture Methods")
                        }

                        Button(
                            onClick = {
                                scope.launch {
                                    isDiscovering = true
                                    errorMessage = null
                                    statusMessage = "Analyzing event structure..."

                                    val result = discoveryService.testEventStructure()
                                    if (result.isSuccess) {
                                        eventAnalysis = result.getOrNull()
                                        statusMessage = "Event structure analyzed"
                                    } else {
                                        errorMessage = result.exceptionOrNull()?.message
                                    }

                                    isDiscovering = false
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = connectionState is ConnectionState.Connected && !isDiscovering
                        ) {
                            if (isDiscovering) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    color = MaterialTheme.colorScheme.onPrimary,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text("🔬 Analyze Event Structure")
                        }

                        Button(
                            onClick = {
                                scope.launch {
                                    isDiscovering = true
                                    errorMessage = null
                                    statusMessage = "Testing SD card access..."

                                    val result = discoveryService.testSdCardBrowsing()
                                    if (result.isSuccess) {
                                        sdCardCapabilities = result.getOrNull()
                                        statusMessage = "SD card capabilities tested"
                                    } else {
                                        errorMessage = result.exceptionOrNull()?.message
                                    }

                                    isDiscovering = false
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = connectionState is ConnectionState.Connected && !isDiscovering
                        ) {
                            if (isDiscovering) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    color = MaterialTheme.colorScheme.onPrimary,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text("💾 Test SD Card Access")
                        }

                        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

                        Text(
                            text = "Capture Workflow Test",
                            style = MaterialTheme.typography.titleSmall,
                            modifier = Modifier.padding(bottom = 8.dp)
                        )

                        Text(
                            text = "Requires: Single Shooting mode + JPEG/RAW+JPEG",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 8.dp)
                        )

                        Button(
                            onClick = {
                                scope.launch {
                                    isDiscovering = true
                                    errorMessage = null
                                    captureWorkflowResult = null
                                    statusMessage = "Running capture workflow (check logcat: SonyCameraApi)..."

                                    val result = apiClient.executeCaptureWorkflow()
                                    captureWorkflowResult = result

                                    if (result.success) {
                                        statusMessage = "Capture workflow complete - ${result.imageUrls.size} image URL(s)"
                                    } else {
                                        statusMessage = "Capture workflow completed with issues - check results below"
                                    }

                                    isDiscovering = false
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = connectionState is ConnectionState.Connected && !isDiscovering,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.tertiary
                            )
                        ) {
                            if (isDiscovering) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    color = MaterialTheme.colorScheme.onTertiary,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text("🎯 Test Full Capture Workflow")
                        }

                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    val results = DiscoveryResults(
                                        availableApis = availableApis,
                                        captureMethodTests = captureTestResults,
                                        eventAnalysis = eventAnalysis,
                                        sdCardCapabilities = sdCardCapabilities,
                                        notes = "Full discovery completed on Sony A7 III"
                                    )

                                    val filename = "sony_a7iii_api_discovery.json"
                                    val json = discoveryService.exportToJson(results)

                                    val exportResult = exportToFile(filename, json)
                                    if (exportResult.isSuccess) {
                                        statusMessage = exportResult.getOrNull()
                                    } else {
                                        errorMessage = exportResult.exceptionOrNull()?.message
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = availableApis.isNotEmpty()
                        ) {
                            Text("💾 Export Results to JSON")
                        }
                    }
                }
            }

            // Available APIs
            if (availableApis.isNotEmpty()) {
                item {
                    Text(
                        text = "Available APIs (${availableApis.size})",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }

                // Group by category
                val groupedApis = availableApis.groupBy { it.category }
                groupedApis.forEach { (category, apis) ->
                    item {
                        Card {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text(
                                    text = "${category.name} (${apis.size})",
                                    style = MaterialTheme.typography.titleSmall,
                                    modifier = Modifier.padding(bottom = 8.dp)
                                )

                                apis.forEach { api ->
                                    Row(
                                        modifier = Modifier.padding(vertical = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Text(
                                            text = "• ${api.name}",
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontFamily = FontFamily.Monospace
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Capture test results
            if (captureTestResults.isNotEmpty()) {
                item {
                    Text(
                        text = "Capture Method Test Results",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }

                items(captureTestResults) { result ->
                    Card {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(
                                    text = result.methodName,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    text = if (result.success) "✓" else "✗",
                                    style = MaterialTheme.typography.titleSmall,
                                    color = if (result.success) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
                                )
                            }

                            if (result.imageUrls.isNotEmpty()) {
                                Text(
                                    text = "Image URLs: ${result.imageUrls.size}",
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.padding(top = 4.dp)
                                )
                                result.imageUrls.forEach { url ->
                                    Text(
                                        text = "  • $url",
                                        style = MaterialTheme.typography.bodySmall,
                                        fontFamily = FontFamily.Monospace,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }

                            Text(
                                text = result.notes,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 4.dp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }

            // Event analysis
            eventAnalysis?.let { analysis ->
                item {
                    Text(
                        text = "Event Structure Analysis",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }

                item {
                    Card {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Total fields: ${analysis.totalFields}", style = MaterialTheme.typography.bodyMedium)
                            Text("takePictureUrl index: ${analysis.takePictureUrlIndex ?: "Not found"}", style = MaterialTheme.typography.bodyMedium)
                            if (analysis.takePictureUrlContent.isNotEmpty()) {
                                Text(
                                    "takePictureUrl content:",
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.padding(top = 8.dp)
                                )
                                Text(
                                    analysis.takePictureUrlContent,
                                    fontFamily = FontFamily.Monospace,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }
            }

            // SD card capabilities
            sdCardCapabilities?.let { capabilities ->
                item {
                    Text(
                        text = "SD Card Capabilities",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }

                item {
                    Card {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(
                                "Browsing supported: ${if (capabilities.browsingSupported) "Yes" else "No"}",
                                style = MaterialTheme.typography.bodyMedium
                            )
                            if (capabilities.availableMethods.isNotEmpty()) {
                                Text(
                                    "Available methods:",
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.padding(top = 8.dp)
                                )
                                capabilities.availableMethods.forEach { method ->
                                    Text(
                                        "  • $method",
                                        fontFamily = FontFamily.Monospace,
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Capture workflow results
            captureWorkflowResult?.let { result ->
                item {
                    Text(
                        text = "Capture Workflow Results",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }

                item {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = if (result.success)
                                MaterialTheme.colorScheme.primaryContainer
                            else
                                MaterialTheme.colorScheme.errorContainer
                        )
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(
                                    text = if (result.success) "✓ SUCCESS" else "⚠ PARTIAL/FAILED",
                                    style = MaterialTheme.typography.titleSmall
                                )
                                Text(
                                    text = "${result.imageUrls.size} image URL(s)",
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }

                            if (result.imageUrls.isNotEmpty()) {
                                Text(
                                    text = "Image URLs:",
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.padding(top = 12.dp)
                                )
                                result.imageUrls.forEach { url ->
                                    Text(
                                        text = url,
                                        fontFamily = FontFamily.Monospace,
                                        style = MaterialTheme.typography.bodySmall,
                                        modifier = Modifier.padding(start = 8.dp, top = 4.dp)
                                    )
                                }
                            }

                            Text(
                                text = "Workflow Steps:",
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 12.dp)
                            )

                            result.steps.forEach { step ->
                                Row(
                                    modifier = Modifier.padding(start = 8.dp, top = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = if (step.success) "✓" else "✗",
                                        color = if (step.success)
                                            MaterialTheme.colorScheme.primary
                                        else
                                            MaterialTheme.colorScheme.error,
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column {
                                        Text(
                                            text = step.name,
                                            fontFamily = FontFamily.Monospace,
                                            style = MaterialTheme.typography.bodySmall
                                        )
                                        Text(
                                            text = step.details,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Bottom padding
            item {
                Spacer(modifier = Modifier.height(16.dp))
            }
        }
    }
}
