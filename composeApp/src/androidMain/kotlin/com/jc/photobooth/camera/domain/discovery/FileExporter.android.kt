package com.jc.photobooth.camera.domain.discovery

import android.os.Environment
import java.io.File

/**
 * Android file export implementation
 * Saves to app-specific external storage directory
 *
 * Note: For Android, we save to Downloads directory which is publicly accessible
 */
actual suspend fun exportToFile(filename: String, content: String): Result<String> {
    return try {
        // Use public Downloads directory
        val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!downloadsDir.exists()) {
            downloadsDir.mkdirs()
        }

        val file = File(downloadsDir, filename)
        file.writeText(content)

        Result.success("Exported to ${file.absolutePath}")
    } catch (e: Exception) {
        Result.failure(Exception("Export failed: ${e.message}", e))
    }
}
