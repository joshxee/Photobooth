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
 * HTTP client for Sony Camera Remote API.
 * Implements JSON-RPC 2.0 protocol over HTTP.
 *
 * Default camera IP: 192.168.122.1 (Sony's standard camera access point IP)
 */
class SonyCameraApiClient(
    private val cameraIp: String = "192.168.122.1",
    private val cameraPort: Int = 10000
) {
    private val baseUrl = "http://$cameraIp:$cameraPort/sony/camera"
    private val liveviewBaseUrl = "http://$cameraIp:$cameraPort"

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
     * Close the HTTP client
     */
    fun close() {
        httpClient.close()
    }

    /**
     * Generic JSON-RPC method caller
     */
    private suspend inline fun <reified T : JsonElement> callMethod(
        method: String,
        params: List<Any> = emptyList(),
        version: String = "1.0"
    ): Result<T> {
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

                val response: HttpResponse = httpClient.post(baseUrl) {
                    contentType(ContentType.Application.Json)
                    setBody(request)
                }

                if (response.status.isSuccess()) {
                    val jsonResponse: JsonRpcResponse<T> = response.body()
                    if (jsonResponse.error != null) {
                        Result.failure(
                            SonyCameraApiException(
                                jsonResponse.error.code,
                                jsonResponse.error.message
                            )
                        )
                    } else {
                        Result.success(jsonResponse.result as T)
                    }
                } else {
                    Result.failure(Exception("HTTP error: ${response.status}"))
                }
            }
        } catch (e: TimeoutCancellationException) {
            Result.failure(Exception("API call timeout: $method", e))
        } catch (e: Exception) {
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
