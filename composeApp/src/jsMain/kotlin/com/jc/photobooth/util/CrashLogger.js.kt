package com.jc.photobooth.util

actual object CrashLogger {
    actual fun install() {}
    actual fun lastCrash(): CrashEntry? = null
}
