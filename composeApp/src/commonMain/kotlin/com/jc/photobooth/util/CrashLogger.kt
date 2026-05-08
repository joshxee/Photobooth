package com.jc.photobooth.util

data class CrashEntry(
    val timestampMillis: Long,
    val message: String,
    val stackPreview: String
)

expect object CrashLogger {
    fun install()
    fun lastCrash(): CrashEntry?
}
