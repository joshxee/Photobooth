package com.jc.photobooth.util

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

private lateinit var appContext: Context

fun initCrashLogger(context: Context) {
    appContext = context.applicationContext
}

actual object CrashLogger {
    actual fun install() {
        if (!::appContext.isInitialized) return
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching { writeCrash(throwable) }
            previous?.uncaughtException(thread, throwable)
        }
    }

    actual fun lastCrash(): CrashEntry? {
        if (!::appContext.isInitialized) return null
        val dir = crashDir() ?: return null
        val newest = dir.listFiles()
            ?.filter { it.isFile && it.extension == "log" }
            ?.maxByOrNull { it.lastModified() }
            ?: return null
        val text = runCatching { newest.readText() }.getOrNull() ?: return null
        val firstLine = text.lineSequence().firstOrNull().orEmpty()
        val preview = text.take(500)
        return CrashEntry(
            timestampMillis = newest.lastModified(),
            message = firstLine,
            stackPreview = preview
        )
    }

    private fun crashDir(): File? {
        return runCatching {
            File(appContext.filesDir, "crashes").apply { if (!exists()) mkdirs() }
        }.getOrNull()
    }

    private fun writeCrash(throwable: Throwable) {
        val dir = crashDir() ?: return
        val sw = StringWriter()
        throwable.printStackTrace(PrintWriter(sw))
        val ts = System.currentTimeMillis()
        val message = throwable.message ?: throwable::class.java.simpleName
        val body = buildString {
            appendLine(message)
            appendLine("---")
            append(sw.toString())
        }
        File(dir, "crash_$ts.log").writeText(body)
    }
}
