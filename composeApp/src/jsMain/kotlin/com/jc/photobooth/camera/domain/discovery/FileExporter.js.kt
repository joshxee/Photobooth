package com.jc.photobooth.camera.domain.discovery

import kotlinx.browser.document
import kotlinx.browser.window
import org.w3c.dom.HTMLAnchorElement
import org.w3c.dom.url.URL
import org.w3c.files.Blob
import org.w3c.files.BlobPropertyBag

/**
 * Web (JS) file export implementation
 * Triggers browser download
 */
actual suspend fun exportToFile(filename: String, content: String): Result<String> {
    return try {
        // Create blob from content
        val blob = Blob(
            arrayOf(content),
            BlobPropertyBag(type = "application/json")
        )

        // Create download link
        val url = URL.createObjectURL(blob)
        val link = document.createElement("a") as HTMLAnchorElement
        link.href = url
        link.download = filename
        link.style.display = "none"

        document.body?.appendChild(link)
        link.click()
        document.body?.removeChild(link)

        URL.revokeObjectURL(url)

        Result.success("Download started: $filename")
    } catch (e: Exception) {
        Result.failure(Exception("Export failed: ${e.message}", e))
    }
}
