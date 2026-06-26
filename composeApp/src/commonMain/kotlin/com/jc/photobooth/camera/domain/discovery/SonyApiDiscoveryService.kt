package com.jc.photobooth.camera.domain.discovery

import com.jc.photobooth.camera.data.sony.SonyCameraApiClient
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonPrimitive

class SonyApiDiscoveryService(
    private val apiClient: SonyCameraApiClient
) {
    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
    }

    /**
     * Discover all available API methods from camera and categorize them
     */
    suspend fun discoverAvailableApis(): Result<List<ApiMethodInfo>> {
        return try {
            val apiListResult = apiClient.getAvailableApiList()
            if (apiListResult.isFailure) {
                return Result.failure(apiListResult.exceptionOrNull() ?: Exception("Failed to get API list"))
            }

            val apiNames = apiListResult.getOrNull() ?: emptyList()
            val apiInfoList = apiNames.map { name ->
                ApiMethodInfo(
                    name = name,
                    category = categorizeMethod(name),
                    description = getMethodDescription(name),
                    isDocumented = isDocumentedMethod(name),
                    testedSuccessfully = false
                )
            }

            Result.success(apiInfoList)
        } catch (e: Exception) {
            Result.failure(Exception("Discovery failed: ${e.message}", e))
        }
    }

    /**
     * Test a single API method with given parameters
     */
    suspend fun testMethod(
        methodName: String,
        params: List<Any>
    ): Result<ApiTestResult> {
        return try {
            val requestJson = buildRequestJson(methodName, params)
            val result = apiClient.invokeMethod(methodName, params)

            val testResult = if (result.isSuccess) {
                val responseJson = json.encodeToString(result.getOrNull())
                ApiTestResult(
                    methodName = methodName,
                    parameters = params.map { it.toString() },
                    requestJson = requestJson,
                    responseJson = responseJson,
                    success = true
                )
            } else {
                val exception = result.exceptionOrNull()
                ApiTestResult(
                    methodName = methodName,
                    parameters = params.map { it.toString() },
                    requestJson = requestJson,
                    responseJson = exception?.message ?: "Unknown error",
                    success = false,
                    errorMessage = exception?.message
                )
            }

            Result.success(testResult)
        } catch (e: Exception) {
            Result.failure(Exception("Test failed: ${e.message}", e))
        }
    }

    /**
     * Test all known capture method variants
     */
    suspend fun testCaptureVariants(): Result<List<CaptureMethodResult>> {
        val captureMethods = listOf(
            "actTakePicture",
            "awaitTakePicture",
            "takePicture",
            "actZoom2Picture",
            "startCapture",
            "captureStill"
        )

        val results = mutableListOf<CaptureMethodResult>()

        for (methodName in captureMethods) {
            try {
                val result = apiClient.invokeMethod(methodName, emptyList())

                if (result.isSuccess) {
                    val jsonElement = result.getOrNull()
                    val imageUrls = extractImageUrls(jsonElement)

                    results.add(
                        CaptureMethodResult(
                            methodName = methodName,
                            success = true,
                            imageUrls = imageUrls,
                            eventDataJson = json.encodeToString(jsonElement),
                            notes = if (imageUrls.isNotEmpty()) "✓ Returns image URLs" else "⚠ No image URLs returned"
                        )
                    )
                } else {
                    val exception = result.exceptionOrNull()
                    results.add(
                        CaptureMethodResult(
                            methodName = methodName,
                            success = false,
                            imageUrls = emptyList(),
                            notes = "✗ ${exception?.message ?: "Failed"}"
                        )
                    )
                }
            } catch (e: Exception) {
                results.add(
                    CaptureMethodResult(
                        methodName = methodName,
                        success = false,
                        imageUrls = emptyList(),
                        notes = "✗ Exception: ${e.message}"
                    )
                )
            }
        }

        return Result.success(results)
    }

    /**
     * Analyze getEvent() response structure to find image URL fields
     */
    suspend fun testEventStructure(): Result<EventStructureAnalysis> {
        return try {
            val result = apiClient.getEvent(longPolling = false)

            if (result.isFailure) {
                return Result.failure(result.exceptionOrNull() ?: Exception("Failed to get event"))
            }

            val event = result.getOrNull()
            val rawData = event?.rawData

            if (rawData == null) {
                return Result.failure(Exception("Invalid event data"))
            }

            val totalFields = rawData.size
            var takePictureUrlIndex: Int? = null
            var takePictureUrlContent = ""
            val otherInterestingFields = mutableMapOf<Int, String>()

            rawData.forEachIndexed { index, element ->
                val elementStr = json.encodeToString(element)

                // Look for takePictureUrl (typically around index 40+)
                if (elementStr.contains("url", ignoreCase = true) ||
                    elementStr.contains("picture", ignoreCase = true) ||
                    elementStr.contains("image", ignoreCase = true)
                ) {
                    if (takePictureUrlIndex == null && index >= 40) {
                        takePictureUrlIndex = index
                        takePictureUrlContent = elementStr
                    }
                    otherInterestingFields[index] = elementStr
                }
            }

            val analysis = EventStructureAnalysis(
                totalFields = totalFields,
                takePictureUrlIndex = takePictureUrlIndex,
                takePictureUrlContent = takePictureUrlContent,
                otherInterestingFields = otherInterestingFields
            )

            Result.success(analysis)
        } catch (e: Exception) {
            Result.failure(Exception("Event analysis failed: ${e.message}", e))
        }
    }

    /**
     * Test SD card browsing capabilities
     */
    suspend fun testSdCardBrowsing(): Result<SdCardCapabilities> {
        val storageMethods = listOf(
            "getContentsURI",
            "getContentList",
            "listImages",
            "getStorageInformation",
            "getSchemeList",
            "getSourceList",
            "getContentCount"
        )

        val testResults = mutableListOf<ApiTestResult>()
        val availableMethods = mutableListOf<String>()

        for (methodName in storageMethods) {
            val testResult = testMethod(methodName, emptyList())
            if (testResult.isSuccess) {
                val result = testResult.getOrNull()
                if (result != null) {
                    testResults.add(result)
                    if (result.success) {
                        availableMethods.add(methodName)
                    }
                }
            }
        }

        val capabilities = SdCardCapabilities(
            browsingSupported = availableMethods.isNotEmpty(),
            availableMethods = availableMethods,
            testResults = testResults
        )

        return Result.success(capabilities)
    }

    /**
     * Categorize API method by name pattern matching
     */
    fun categorizeMethod(methodName: String): ApiCategory {
        return when {
            methodName.contains("takePicture", ignoreCase = true) ||
                    methodName.contains("shoot", ignoreCase = true) ||
                    methodName.contains("capture", ignoreCase = true) ||
                    methodName.contains("shutter", ignoreCase = true) -> ApiCategory.CAPTURE

            methodName.contains("liveview", ignoreCase = true) ||
                    methodName.contains("preview", ignoreCase = true) -> ApiCategory.LIVEVIEW

            methodName.contains("set", ignoreCase = true) ||
                    methodName.contains("get", ignoreCase = true) && (
                    methodName.contains("mode", ignoreCase = true) ||
                            methodName.contains("setting", ignoreCase = true) ||
                            methodName.contains("focus", ignoreCase = true) ||
                            methodName.contains("exposure", ignoreCase = true) ||
                            methodName.contains("iso", ignoreCase = true)
                    ) -> ApiCategory.SETTINGS

            methodName.contains("event", ignoreCase = true) ||
                    methodName.contains("status", ignoreCase = true) -> ApiCategory.EVENTS

            methodName.contains("storage", ignoreCase = true) ||
                    methodName.contains("content", ignoreCase = true) ||
                    methodName.contains("URI", ignoreCase = false) ||
                    methodName.contains("image", ignoreCase = true) -> ApiCategory.STORAGE

            else -> ApiCategory.UNKNOWN
        }
    }

    /**
     * Export discovery results to JSON string
     */
    fun exportToJson(results: DiscoveryResults): String {
        return json.encodeToString(results)
    }

    // Helper methods

    private fun buildRequestJson(methodName: String, params: List<Any>): String {
        val request = mapOf(
            "method" to methodName,
            "params" to params,
            "id" to 1,
            "version" to "1.0"
        )
        return json.encodeToString(request)
    }

    private fun extractImageUrls(jsonElement: JsonElement?): List<String> {
        if (jsonElement == null) return emptyList()

        return try {
            when (jsonElement) {
                is JsonArray -> {
                    // Response format: [["url1", "url2", ...]]
                    val innerArray = jsonElement.firstOrNull() as? JsonArray
                    innerArray?.mapNotNull {
                        try {
                            it.jsonPrimitive.content
                        } catch (_: Exception) {
                            null
                        }
                    }?.filter { it.startsWith("http") } ?: emptyList()
                }
                else -> emptyList()
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun getMethodDescription(methodName: String): String {
        return when (methodName) {
            "actTakePicture" -> "Take a single photo"
            "awaitTakePicture" -> "Take photo and wait for completion"
            "startLiveview" -> "Start live view stream"
            "stopLiveview" -> "Stop live view stream"
            "getEvent" -> "Get camera event data"
            "startContShooting" -> "Start continuous shooting"
            "stopContShooting" -> "Stop continuous shooting"
            "actHalfPressShutter" -> "Autofocus (half-press shutter)"
            "cancelHalfPressShutter" -> "Cancel autofocus"
            "getAvailableApiList" -> "Get list of available API methods"
            "startRecMode" -> "Start recording mode"
            "stopRecMode" -> "Stop recording mode"
            else -> ""
        }
    }

    private fun isDocumentedMethod(methodName: String): Boolean {
        val documentedMethods = setOf(
            "actTakePicture", "startLiveview", "stopLiveview", "getEvent",
            "actHalfPressShutter", "cancelHalfPressShutter", "getAvailableApiList",
            "startRecMode", "stopRecMode", "setShootMode", "getAvailableShootMode",
            "startContShooting", "stopContShooting"
        )
        return methodName in documentedMethods
    }
}
