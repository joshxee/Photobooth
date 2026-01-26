package com.jc.photobooth.camera.domain.discovery

import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSDocumentDirectory
import platform.Foundation.NSFileManager
import platform.Foundation.NSURL
import platform.Foundation.NSUserDomainMask

/**
 * iOS file export implementation
 * Saves to Documents directory
 */
@OptIn(ExperimentalForeignApi::class)
actual suspend fun exportToFile(filename: String, content: String): Result<String> {
    return try {
        val fileManager = NSFileManager.defaultManager
        val documentsUrl = fileManager.URLForDirectory(
            NSDocumentDirectory,
            NSUserDomainMask,
            null,
            true,
            null
        ) as NSURL

        val fileUrl = documentsUrl.URLByAppendingPathComponent(filename)
        val filePath = fileUrl?.path ?: return Result.failure(Exception("Failed to create file path"))

        // Write content to file
        platform.Foundation.NSString.create(string = content)
            .writeToFile(filePath, atomically = true, encoding = platform.Foundation.NSUTF8StringEncoding, error = null)

        Result.success("Exported to $filePath")
    } catch (e: Exception) {
        Result.failure(Exception("Export failed: ${e.message}", e))
    }
}
