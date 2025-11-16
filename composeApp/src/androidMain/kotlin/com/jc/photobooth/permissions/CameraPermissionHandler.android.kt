package com.jc.photobooth.permissions

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * Android implementation of CameraPermissionHandler.
 *
 * This implementation uses Android's runtime permission system.
 * Note: Permission requests need to be initiated from an Activity context using
 * ActivityResultContracts.RequestPermission(), so this handler tracks state
 * and the actual request is delegated to the UI layer.
 */
class AndroidCameraPermissionHandler(
    private val context: Context
) : CameraPermissionHandler {

    private var lastCheckedState: PermissionState = PermissionState.NOT_DETERMINED

    override fun checkPermission(): PermissionState {
        val state = when {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED -> PermissionState.GRANTED

            else -> {
                // On Android, we can't reliably detect "permanently denied" vs "denied"
                // without attempting a request and checking shouldShowRequestPermissionRationale
                // For now, we return DENIED if not granted
                lastCheckedState.takeIf { it != PermissionState.GRANTED }
                    ?: PermissionState.DENIED
            }
        }
        lastCheckedState = state
        return state
    }

    override fun requestPermission(): PermissionState {
        // Note: Actual permission request must be done via ActivityResultContract
        // from the UI layer. This method just returns the current state.
        // The UI layer should call checkPermission() after the request completes.
        return checkPermission()
    }

    /**
     * Update the permission state after a request is completed.
     * This should be called by the UI layer after the permission result is received.
     */
    fun updatePermissionResult(granted: Boolean, shouldShowRationale: Boolean) {
        lastCheckedState = when {
            granted -> PermissionState.GRANTED
            shouldShowRationale -> PermissionState.DENIED
            else -> PermissionState.PERMANENTLY_DENIED
        }
    }

    override fun openSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(intent)
    }
}

actual fun createCameraPermissionHandler(): CameraPermissionHandler {
    throw IllegalStateException(
        "Use createCameraPermissionHandler(Context) on Android. " +
        "This function requires Android Context to be provided."
    )
}

/**
 * Android-specific factory function that requires Context.
 */
fun createCameraPermissionHandler(context: Context): AndroidCameraPermissionHandler {
    return AndroidCameraPermissionHandler(context)
}
