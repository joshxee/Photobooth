package com.jc.photobooth.camera.domain.discovery

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Category of Sony Camera API method
 */
@Serializable
enum class ApiCategory {
    CAPTURE,      // Photo/video capture methods
    LIVEVIEW,     // Live view streaming methods
    SETTINGS,     // Camera settings and configuration
    EVENTS,       // Event polling and status
    STORAGE,      // SD card and storage access
    UNKNOWN       // Uncategorized methods
}

/**
 * Information about a discovered API method
 */
@Serializable
data class ApiMethodInfo(
    val name: String,
    val category: ApiCategory,
    val description: String = "",
    val isDocumented: Boolean = true,
    val testedSuccessfully: Boolean = false
)

/**
 * Result of testing a single API method
 */
@Serializable
data class ApiTestResult(
    val methodName: String,
    val parameters: List<String>,  // Serialized parameter values
    val requestJson: String,
    val responseJson: String,
    val success: Boolean,
    val errorCode: Int? = null,
    val errorMessage: String? = null,
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * Result of testing a capture method variant
 */
@Serializable
data class CaptureMethodResult(
    val methodName: String,
    val success: Boolean,
    val imageUrls: List<String>,
    val eventDataJson: String? = null,
    val notes: String = ""
)

/**
 * Analysis of getEvent() response structure
 */
@Serializable
data class EventStructureAnalysis(
    val totalFields: Int,
    val takePictureUrlIndex: Int? = null,
    val takePictureUrlContent: String = "",
    val otherInterestingFields: Map<Int, String> = emptyMap()
)

/**
 * SD card browsing capabilities test results
 */
@Serializable
data class SdCardCapabilities(
    val browsingSupported: Boolean,
    val availableMethods: List<String>,
    val testResults: List<ApiTestResult>
)

/**
 * Complete discovery results for export
 */
@Serializable
data class DiscoveryResults(
    val timestamp: Long = System.currentTimeMillis(),
    val cameraModel: String = "Sony A7 III",
    val availableApis: List<ApiMethodInfo>,
    val captureMethodTests: List<CaptureMethodResult> = emptyList(),
    val eventAnalysis: EventStructureAnalysis? = null,
    val sdCardCapabilities: SdCardCapabilities? = null,
    val notes: String = ""
)
