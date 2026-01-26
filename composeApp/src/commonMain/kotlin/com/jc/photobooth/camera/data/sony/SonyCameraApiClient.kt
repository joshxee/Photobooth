package com.jc.photobooth.camera.data.sony

import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/**
 * Logging tag for Sony Camera API calls.
 * Filter in logcat with: adb logcat -s SonyCameraApi
 */
const val SONY_CAMERA_LOG_TAG = "SonyCameraApi"

/**
 * Logger interface for platform-specific logging.
 * Set via SonyCameraApiClient.logger to enable logging.
 */
interface SonyCameraLogger {
    fun d(tag: String, message: String)
    fun i(tag: String, message: String)
    fun w(tag: String, message: String)
    fun e(tag: String, message: String, throwable: Throwable? = null)
}

/**
 * Default no-op logger (logging disabled)
 */
object NoOpLogger : SonyCameraLogger {
    override fun d(tag: String, message: String) {}
    override fun i(tag: String, message: String) {}
    override fun w(tag: String, message: String) {}
    override fun e(tag: String, message: String, throwable: Throwable?) {}
}

/**
 * Simple println logger for non-Android platforms
 */
object PrintLogger : SonyCameraLogger {
    override fun d(tag: String, message: String) = println("D/$tag: $message")
    override fun i(tag: String, message: String) = println("I/$tag: $message")
    override fun w(tag: String, message: String) = println("W/$tag: $message")
    override fun e(tag: String, message: String, throwable: Throwable?) {
        println("E/$tag: $message")
        throwable?.printStackTrace()
    }
}

/**
 * Platform-specific logger factory.
 * Returns the appropriate logger for the current platform:
 * - Android: Uses Android Log for proper logcat integration
 * - Other platforms: Uses PrintLogger
 */
expect fun createPlatformLogger(): SonyCameraLogger

/**
 * HTTP client for Sony Camera Remote API.
 * Implements JSON-RPC 2.0 protocol over HTTP.
 *
 * Default camera IP: 192.168.122.1 (Sony's standard camera access point IP)
 */
class SonyCameraApiClient(
    private val cameraIp: String = "192.168.122.1",
    private val cameraPort: Int = 10000,
    val logger: SonyCameraLogger = NoOpLogger
) {
    private val baseUrl = "http://$cameraIp:$cameraPort/sony/camera"
    private val liveviewBaseUrl = "http://$cameraIp:$cameraPort"
    private val tag = SONY_CAMERA_LOG_TAG

    private var requestId = 1

    private val httpClient = HttpClient {
        install(ContentNegotiation) {
            json(Json {
                ignoreUnknownKeys = true
                prettyPrint = false
                isLenient = true
            })
        }
        expectSuccess = false // Handle errors manually
    }

    /**
     * Get list of available API methods from the camera
     * Response format: [["api1", "api2", ...]]
     */
    suspend fun getAvailableApiList(): Result<List<String>> {
        return callMethod<JsonArray>("getAvailableApiList").map { jsonArray ->
            // Response is nested: [["api1", "api2", ...]]
            // Extract the inner array
            val innerArray = jsonArray.firstOrNull() as? JsonArray
            innerArray?.map { it.toString().removeSurrounding("\"") } ?: emptyList()
        }
    }

    /**
     * Start recording mode (required before most operations)
     */
    suspend fun startRecMode(): Result<Unit> {
        return callMethod<JsonArray>("startRecMode").map { }
    }

    /**
     * Stop recording mode
     */
    suspend fun stopRecMode(): Result<Unit> {
        return callMethod<JsonArray>("stopRecMode").map { }
    }

    /**
     * Half-press shutter (for autofocus)
     */
    suspend fun actHalfPressShutter(): Result<Unit> {
        return callMethod<JsonArray>("actHalfPressShutter").map { }
    }

    /**
     * Cancel half-press shutter
     */
    suspend fun cancelHalfPressShutter(): Result<Unit> {
        return callMethod<JsonArray>("cancelHalfPressShutter").map { }
    }

    /**
     * Take a picture and return the image URL(s)
     */
    suspend fun actTakePicture(): Result<List<String>> {
        return callMethod<JsonArray>("actTakePicture").map { result ->
            // Response is [[url1, url2, ...]]
            val innerArray = result.firstOrNull() as? JsonArray
            innerArray?.mapNotNull { it.toString().removeSurrounding("\"") } ?: emptyList()
        }
    }

    /**
     * Start live view streaming and return the stream URL
     */
    suspend fun startLiveview(): Result<String> {
        return callMethod<JsonArray>("startLiveview").map { result ->
            result.firstOrNull()?.toString()?.removeSurrounding("\"")
                ?: throw IllegalStateException("No liveview URL in response")
        }
    }

    /**
     * Stop live view streaming
     */
    suspend fun stopLiveview(): Result<Unit> {
        return callMethod<JsonArray>("stopLiveview").map { }
    }

    /**
     * Get camera event (state changes)
     * @param longPolling If true, request will block until state changes
     */
    suspend fun getEvent(longPolling: Boolean = false): Result<CameraEvent> {
        return callMethod<JsonArray>("getEvent", listOf(longPolling)).map { result ->
            CameraEvent(rawData = result)
        }
    }

    /**
     * Get list of temporarily unavailable APIs and reasons
     */
    suspend fun getTemporarilyUnavailableApiList(): Result<JsonArray> {
        return callMethod<JsonArray>("getTemporarilyUnavailableApiList")
    }

    /**
     * Start continuous shooting (alternative to actTakePicture)
     */
    suspend fun startContShooting(): Result<List<String>> {
        return callMethod<JsonArray>("startContShooting").map { result ->
            // Response is [[url1, url2, ...]]
            val innerArray = result.firstOrNull() as? JsonArray
            innerArray?.mapNotNull { it.toString().removeSurrounding("\"") } ?: emptyList()
        }
    }

    /**
     * Stop continuous shooting
     */
    suspend fun stopContShooting(): Result<Unit> {
        return callMethod<JsonArray>("stopContShooting").map { }
    }

    /**
     * Set shoot mode (e.g., "still", "movie", "audio", "intervalstill")
     */
    suspend fun setShootMode(mode: String): Result<Unit> {
        return callMethod<JsonArray>("setShootMode", listOf(mode)).map { }
    }

    /**
     * Get available shoot modes
     */
    suspend fun getAvailableShootMode(): Result<List<String>> {
        return callMethod<JsonArray>("getAvailableShootMode").map { result ->
            val modesArray = result.firstOrNull() as? JsonArray
            modesArray?.mapNotNull { it.toString().removeSurrounding("\"") } ?: emptyList()
        }
    }

    /**
     * Download image data from a URL provided by the camera
     */
    suspend fun downloadImage(url: String): Result<ByteArray> {
        return try {
            withTimeout(30000) { // 30 second timeout for image download
                val response: HttpResponse = httpClient.get(url)
                if (response.status.isSuccess()) {
                    Result.success(response.body())
                } else {
                    Result.failure(Exception("Failed to download image: ${response.status}"))
                }
            }
        } catch (e: TimeoutCancellationException) {
            Result.failure(Exception("Image download timeout", e))
        } catch (e: Exception) {
            Result.failure(Exception("Image download failed: ${e.message}", e))
        }
    }

    /**
     * Get live view stream as ByteArray for parsing
     */
    suspend fun getLiveviewStream(url: String): Result<HttpStatement> {
        return try {
            val statement = httpClient.prepareGet(url)
            Result.success(statement)
        } catch (e: Exception) {
            Result.failure(Exception("Failed to start liveview stream: ${e.message}", e))
        }
    }

    /**
     * Invoke any camera API method dynamically (for discovery/testing)
     * Returns raw JsonElement for flexible response parsing
     */
    suspend fun invokeMethod(
        methodName: String,
        params: List<Any> = emptyList(),
        version: String = "1.0"
    ): Result<JsonElement> {
        return callMethod<JsonElement>(methodName, params, version)
    }

    /**
     * Close the HTTP client
     */
    fun close() {
        httpClient.close()
    }

    /**
     * Execute the full capture workflow:
     * 1. Start live view (for camera to be ready)
     * 2. Wait for stabilization
     * 3. Half-press shutter (autofocus)
     * 4. Wait for focus lock
     * 5. Take picture
     * 6. Return image URLs (if any)
     *
     * @return Result containing image URLs or failure with detailed error
     */
    suspend fun executeCaptureWorkflow(): CaptureWorkflowResult {
        val steps = mutableListOf<CaptureWorkflowStep>()
        var imageUrls: List<String> = emptyList()

        logger.i(tag, "╔══════════════════════════════════════════════════════════════════")
        logger.i(tag, "║ CAPTURE WORKFLOW STARTED")
        logger.i(tag, "╚══════════════════════════════════════════════════════════════════")

        // Step 1: Start live view
        logger.i(tag, "┌─ STEP 1: Start Live View ─────────────────────────────────────────")
        val liveviewResult = startLiveview()
        if (liveviewResult.isFailure) {
            val error = liveviewResult.exceptionOrNull()?.message ?: "Unknown error"
            logger.w(tag, "└─ Live view failed (may already be running): $error")
            steps.add(CaptureWorkflowStep("startLiveview", false, "Failed: $error (continuing anyway)"))
        } else {
            val liveviewUrl = liveviewResult.getOrNull()
            logger.i(tag, "└─ Live view started: $liveviewUrl")
            steps.add(CaptureWorkflowStep("startLiveview", true, "URL: $liveviewUrl"))
        }

        // Step 2: Wait for stabilization
        logger.i(tag, "┌─ STEP 2: Wait for Camera Stabilization (500ms) ─────────────────")
        kotlinx.coroutines.delay(500)
        logger.i(tag, "└─ Stabilization complete")
        steps.add(CaptureWorkflowStep("stabilization", true, "500ms delay"))

        // Step 3: Autofocus (half-press shutter)
        logger.i(tag, "┌─ STEP 3: Autofocus (Half-Press Shutter) ─────────────────────────")
        val focusResult = actHalfPressShutter()
        if (focusResult.isFailure) {
            val error = focusResult.exceptionOrNull()?.message ?: "Unknown error"
            logger.e(tag, "└─ ✗ Autofocus FAILED: $error")
            steps.add(CaptureWorkflowStep("actHalfPressShutter", false, error))
            // Don't abort - some cameras work without explicit focus
            logger.w(tag, "   Continuing without focus lock...")
        } else {
            logger.i(tag, "└─ ✓ Autofocus triggered")
            steps.add(CaptureWorkflowStep("actHalfPressShutter", true, "Focus triggered"))
        }

        // Step 4: Wait for focus acquisition
        logger.i(tag, "┌─ STEP 4: Wait for Focus Lock (300ms) ────────────────────────────")
        kotlinx.coroutines.delay(300)
        logger.i(tag, "└─ Focus wait complete")
        steps.add(CaptureWorkflowStep("focusWait", true, "300ms delay"))

        // Step 5: Take picture
        logger.i(tag, "┌─ STEP 5: Take Picture (actTakePicture) ──────────────────────────")
        val captureResult = actTakePicture()
        if (captureResult.isFailure) {
            val error = captureResult.exceptionOrNull()?.message ?: "Unknown error"
            logger.e(tag, "└─ ✗ CAPTURE FAILED: $error")
            steps.add(CaptureWorkflowStep("actTakePicture", false, error))
        } else {
            imageUrls = captureResult.getOrNull() ?: emptyList()
            if (imageUrls.isNotEmpty()) {
                logger.i(tag, "└─ ✓ CAPTURE SUCCESS - ${imageUrls.size} image URL(s):")
                imageUrls.forEachIndexed { index, url ->
                    logger.i(tag, "   [$index] $url")
                }
                steps.add(CaptureWorkflowStep("actTakePicture", true, "URLs: ${imageUrls.joinToString(", ")}"))
            } else {
                logger.w(tag, "└─ ⚠ Capture returned success but NO IMAGE URLs")
                steps.add(CaptureWorkflowStep("actTakePicture", true, "Success but no URLs returned"))
            }
        }

        // Step 6: Cancel half-press (release focus)
        logger.i(tag, "┌─ STEP 6: Release Focus (Cancel Half-Press) ─────────────────────")
        val cancelResult = cancelHalfPressShutter()
        if (cancelResult.isFailure) {
            logger.w(tag, "└─ Release focus failed (non-critical)")
            steps.add(CaptureWorkflowStep("cancelHalfPressShutter", false, "Non-critical failure"))
        } else {
            logger.i(tag, "└─ ✓ Focus released")
            steps.add(CaptureWorkflowStep("cancelHalfPressShutter", true, "Focus released"))
        }

        // Summary
        val success = imageUrls.isNotEmpty()
        logger.i(tag, "╔══════════════════════════════════════════════════════════════════")
        logger.i(tag, "║ CAPTURE WORKFLOW ${if (success) "✓ COMPLETE" else "⚠ PARTIAL"}")
        logger.i(tag, "║ Image URLs: ${imageUrls.size}")
        if (imageUrls.isNotEmpty()) {
            imageUrls.forEach { logger.i(tag, "║   → $it") }
        }
        logger.i(tag, "╚══════════════════════════════════════════════════════════════════")

        return CaptureWorkflowResult(
            success = success,
            imageUrls = imageUrls,
            steps = steps
        )
    }

    /**
     * Generic JSON-RPC method caller with comprehensive logging
     */
    private suspend inline fun <reified T : JsonElement> callMethod(
        method: String,
        params: List<Any> = emptyList(),
        version: String = "1.0"
    ): Result<T> {
        val currentRequestId = requestId
        logger.d(tag, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        logger.d(tag, "API_CALL [$currentRequestId] → $method")
        if (params.isNotEmpty()) {
            logger.d(tag, "API_CALL [$currentRequestId] params: $params")
        }

        return try {
            withTimeout(10000) { // 10 second timeout for API calls
                val request = JsonRpcRequest(
                    method = method,
                    params = params.map { param ->
                        when (param) {
                            is String -> JsonPrimitive(param)
                            is Boolean -> JsonPrimitive(param)
                            is Number -> JsonPrimitive(param)
                            is JsonElement -> param
                            else -> JsonPrimitive(param.toString())
                        }
                    },
                    id = requestId++,
                    version = version
                )

                logger.d(tag, "API_CALL [$currentRequestId] sending to: $baseUrl")

                val response: HttpResponse = httpClient.post(baseUrl) {
                    contentType(ContentType.Application.Json)
                    setBody(request)
                }

                logger.d(tag, "API_CALL [$currentRequestId] HTTP ${response.status}")

                if (response.status.isSuccess()) {
                    val jsonResponse: JsonRpcResponse<T> = response.body()
                    if (jsonResponse.error != null) {
                        logger.e(tag, "API_CALL [$currentRequestId] ✗ ERROR code=${jsonResponse.error.code} msg='${jsonResponse.error.message}'")
                        Result.failure(
                            SonyCameraApiException(
                                jsonResponse.error.code,
                                jsonResponse.error.message
                            )
                        )
                    } else {
                        val resultStr = jsonResponse.result.toString()
                        val truncated = if (resultStr.length > 200) resultStr.take(200) + "..." else resultStr
                        logger.i(tag, "API_CALL [$currentRequestId] ✓ SUCCESS result: $truncated")
                        Result.success(jsonResponse.result as T)
                    }
                } else {
                    logger.e(tag, "API_CALL [$currentRequestId] ✗ HTTP ERROR ${response.status}")
                    Result.failure(Exception("HTTP error: ${response.status}"))
                }
            }
        } catch (e: TimeoutCancellationException) {
            logger.e(tag, "API_CALL [$currentRequestId] ✗ TIMEOUT after 10s", e)
            Result.failure(Exception("API call timeout: $method", e))
        } catch (e: Exception) {
            logger.e(tag, "API_CALL [$currentRequestId] ✗ EXCEPTION: ${e.message}", e)
            Result.failure(Exception("API call failed: $method - ${e.message}", e))
        }
    }
}

/**
 * JSON-RPC request format
 */
@Serializable
data class JsonRpcRequest(
    val method: String,
    val params: List<JsonElement>,
    val id: Int,
    val version: String
)

/**
 * JSON-RPC response format
 */
@Serializable
data class JsonRpcResponse<T>(
    val result: T? = null,
    @Serializable(with = JsonRpcErrorSerializer::class)
    val error: JsonRpcError? = null,
    val id: Int
)

/**
 * JSON-RPC error format
 * Sony Camera API returns errors as: [errorCode, methodName]
 */
@Serializable
data class JsonRpcError(
    val code: Int,
    val message: String
)

/**
 * Custom serializer for Sony Camera API error format
 * Handles array format: [errorCode, methodName]
 */
object JsonRpcErrorSerializer : JsonTransformingSerializer<JsonRpcError>(JsonRpcError.serializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement {
        // Sony API returns error as array: [code, message]
        if (element is JsonArray && element.size >= 2) {
            return buildJsonObject {
                put("code", element[0])
                put("message", element[1])
            }
        }
        // Already in object format (fallback for other implementations)
        return element
    }
}

/**
 * Camera event data
 */
data class CameraEvent(
    val rawData: JsonArray
)

/**
 * Exception thrown when Sony Camera API returns an error
 */
class SonyCameraApiException(
    val errorCode: Int,
    message: String
) : Exception("Sony Camera API Error [$errorCode]: $message")

/**
 * Result of a capture workflow execution
 */
data class CaptureWorkflowResult(
    val success: Boolean,
    val imageUrls: List<String>,
    val steps: List<CaptureWorkflowStep>
)

/**
 * Individual step in the capture workflow
 */
data class CaptureWorkflowStep(
    val name: String,
    val success: Boolean,
    val details: String
)
