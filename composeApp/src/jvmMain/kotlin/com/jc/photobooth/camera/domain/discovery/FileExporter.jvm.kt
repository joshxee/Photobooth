package com.jc.photobooth.camera.domain.discovery

import java.io.File
import javax.swing.JFileChooser
import javax.swing.filechooser.FileNameExtensionFilter

/**
 * Desktop (JVM) file export implementation using Swing file chooser
 */
actual suspend fun exportToFile(filename: String, content: String): Result<String> {
    return try {
        val fileChooser = JFileChooser().apply {
            dialogTitle = "Export Discovery Results"
            selectedFile = File(filename)
            fileFilter = FileNameExtensionFilter("JSON Files", "json")
        }

        val result = fileChooser.showSaveDialog(null)

        if (result == JFileChooser.APPROVE_OPTION) {
            val file = fileChooser.selectedFile
            file.writeText(content)
            Result.success("Exported to ${file.absolutePath}")
        } else {
            Result.failure(Exception("Export cancelled"))
        }
    } catch (e: Exception) {
        Result.failure(Exception("Export failed: ${e.message}", e))
    }
}
