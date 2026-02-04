package com.jc.photobooth.kiosk

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * JVM/Desktop implementation of KioskModeManager (stub).
 *
 * Kiosk mode is primarily useful on Android tablets.
 * On desktop, fullscreen mode can be achieved via window management.
 *
 * This stub implementation allows the code to compile for JVM target
 * but doesn't implement actual kiosk mode functionality.
 */
actual class KioskModeManager {
    private val _isKioskModeEnabled = MutableStateFlow(false)
    actual val isKioskModeEnabled: StateFlow<Boolean> = _isKioskModeEnabled.asStateFlow()

    /**
     * Enable kiosk mode (no-op on JVM).
     */
    actual suspend fun enableKioskMode(): Result<Unit> {
        // No-op on desktop - kiosk mode not applicable
        _isKioskModeEnabled.value = true
        return Result.success(Unit)
    }

    /**
     * Disable kiosk mode (no-op on JVM).
     */
    actual suspend fun disableKioskMode(): Result<Unit> {
        // No-op on desktop - kiosk mode not applicable
        _isKioskModeEnabled.value = false
        return Result.success(Unit)
    }
}
