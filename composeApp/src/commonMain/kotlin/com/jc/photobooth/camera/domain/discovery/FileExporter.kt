package com.jc.photobooth.camera.domain.discovery

/**
 * Platform-specific file export functionality
 *
 * @param filename Suggested filename
 * @param content File content as string
 * @return Result with success message or error
 */
expect suspend fun exportToFile(filename: String, content: String): Result<String>
