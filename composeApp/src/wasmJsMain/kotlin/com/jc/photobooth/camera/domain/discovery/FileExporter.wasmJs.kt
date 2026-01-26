package com.jc.photobooth.camera.domain.discovery

/**
 * Web (Wasm) file export implementation
 * For now, provides a simple message - full implementation requires Wasm DOM APIs
 */
actual suspend fun exportToFile(filename: String, content: String): Result<String> {
    // TODO: Implement Wasm-specific file export when DOM APIs are available
    // For now, return the content and filename for manual copy
    return Result.success("Export prepared: $filename\n\nContent available in console. Full export not yet implemented for Wasm.")
}
