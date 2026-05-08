package com.jc.photobooth.util

// iOS implementation deferred — see wiki/Production-Readiness.md.
// NSSetUncaughtExceptionHandler integration with Kotlin/Native staticCFunction
// requires C interop bridging that we have not yet validated against the
// project's Kotlin/Native toolchain. Android handler is wired in MainActivity
// and writes to filesDir/crashes/.
actual object CrashLogger {
    actual fun install() {}
    actual fun lastCrash(): CrashEntry? = null
}
