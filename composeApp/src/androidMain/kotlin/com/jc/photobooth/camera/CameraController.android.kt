package com.jc.photobooth.camera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import com.jc.photobooth.model.PhotoData
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Android implementation of CameraController using CameraX.
 */
class AndroidCameraController(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val executor: Executor
) : CameraController {

    private var camera: Camera? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null
    private var cameraProvider: ProcessCameraProvider? = null

    override fun startPreview() {
        // Preview will be started when provider is bound
        // Actual binding happens in the UI layer
    }

    override fun stopPreview() {
        cameraProvider?.unbindAll()
    }

    override suspend fun capturePhoto(): PhotoData {
        val imageCapture = imageCapture ?: throw IllegalStateException("Camera not initialized")

        return suspendCancellableCoroutine { continuation ->
            imageCapture.takePicture(
                executor,
                object : ImageCapture.OnImageCapturedCallback() {
                    override fun onCaptureSuccess(image: ImageProxy) {
                        try {
                            val bytes = imageProxyToJpegBytes(image)
                            val photoData = PhotoData(bytes, System.currentTimeMillis())
                            continuation.resume(photoData)
                        } catch (e: Exception) {
                            continuation.resumeWithException(e)
                        } finally {
                            image.close()
                        }
                    }

                    override fun onError(exception: ImageCaptureException) {
                        continuation.resumeWithException(exception)
                    }
                }
            )
        }
    }

    /**
     * Convert ImageProxy to JPEG bytes.
     * Handles both YUV and JPEG formats.
     */
    private fun imageProxyToJpegBytes(image: ImageProxy): ByteArray {
        return when (image.format) {
            ImageFormat.JPEG -> {
                // Image is already JPEG encoded
                val buffer = image.planes[0].buffer
                val bytes = ByteArray(buffer.remaining())
                buffer.get(bytes)
                bytes
            }
            else -> {
                // Convert YUV to JPEG
                val yBuffer = image.planes[0].buffer
                val uBuffer = image.planes[1].buffer
                val vBuffer = image.planes[2].buffer

                val ySize = yBuffer.remaining()
                val uSize = uBuffer.remaining()
                val vSize = vBuffer.remaining()

                val nv21 = ByteArray(ySize + uSize + vSize)
                yBuffer.get(nv21, 0, ySize)
                vBuffer.get(nv21, ySize, vSize)
                uBuffer.get(nv21, ySize + vSize, uSize)

                val yuvImage = YuvImage(nv21, ImageFormat.NV21, image.width, image.height, null)
                val out = ByteArrayOutputStream()
                yuvImage.compressToJpeg(Rect(0, 0, image.width, image.height), 90, out)
                out.toByteArray()
            }
        }
    }

    override fun release() {
        cameraProvider?.unbindAll()
    }

    /**
     * Initialize the camera with preview and capture capabilities.
     * This should be called from the UI layer.
     */
    suspend fun initialize(): Preview {
        cameraProvider = getCameraProvider()

        preview = Preview.Builder().build()
        imageCapture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setTargetRotation(android.view.Surface.ROTATION_0)
            .build()

        val cameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA

        cameraProvider?.unbindAll()
        camera = cameraProvider?.bindToLifecycle(
            lifecycleOwner,
            cameraSelector,
            preview,
            imageCapture
        )

        return preview!!
    }

    private suspend fun getCameraProvider(): ProcessCameraProvider =
        suspendCancellableCoroutine { continuation ->
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({
                try {
                    continuation.resume(future.get())
                } catch (e: Exception) {
                    continuation.resumeWithException(e)
                }
            }, executor)
        }

    fun getPreview(): Preview? = preview
}

actual fun createCameraController(): CameraController {
    throw IllegalStateException(
        "Use createCameraController(Context, LifecycleOwner, Executor) on Android"
    )
}

/**
 * Android-specific factory function.
 */
fun createCameraController(
    context: Context,
    lifecycleOwner: LifecycleOwner,
    executor: Executor
): AndroidCameraController {
    return AndroidCameraController(context, lifecycleOwner, executor)
}
