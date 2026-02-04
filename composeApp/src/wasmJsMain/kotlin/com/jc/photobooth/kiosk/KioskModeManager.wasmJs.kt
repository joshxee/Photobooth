package com.jc.photobooth.kiosk

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * WasmJS/Web implementation of KioskModeManager (stub).
 *
 * Kiosk mode on web would require browser fullscreen API.
 * This stub implementation allows the code to compile for WasmJS target
 * but doesn't implement actual kiosk mode functionality.
 *
 * For production web kiosk deployment, consider:
 * - Fullscreen API (document.requestFullscreen())
 * - Browser kiosk mode (browser flag or extension)
 */
actual class KioskModeManager {
    private val _isKioskModeEnabled = MutableStateFlow(false)
    actual val isKioskModeEnabled: StateFlow<Boolean> = _isKioskModeEnabled.asStateFlow()

    /**
     * Enable kiosk mode (no-op on web).
     */
    actual suspend fun enableKioskMode(): Result<Unit> {
        // No-op - kiosk mode would require fullscreen API on web
        _isKioskModeEnabled.value = true
        return Result.success(Unit)
    }

    /**
     * Disable kiosk mode (no-op on web).
     */
    actual suspend fun disableKioskMode(): Result<Unit> {
        // No-op - kiosk mode would require fullscreen API on web
        _isKioskModeEnabled.value = false
        return Result.success(Unit)
    }
}
