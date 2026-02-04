package com.jc.photobooth.kiosk

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * iOS implementation of KioskModeManager (stub).
 *
 * Kiosk mode on iOS would require Guided Access or MDM configuration.
 * This stub implementation allows the code to compile for iOS target
 * but doesn't implement actual kiosk mode functionality.
 *
 * For production iOS kiosk deployment, consider:
 * - Guided Access (user-enabled per-session)
 * - Single App Mode via MDM (requires MDM enrollment)
 */
actual class KioskModeManager {
    private val _isKioskModeEnabled = MutableStateFlow(false)
    actual val isKioskModeEnabled: StateFlow<Boolean> = _isKioskModeEnabled.asStateFlow()

    /**
     * Enable kiosk mode (no-op on iOS).
     */
    actual suspend fun enableKioskMode(): Result<Unit> {
        // No-op - kiosk mode requires Guided Access or MDM on iOS
        _isKioskModeEnabled.value = true
        return Result.success(Unit)
    }

    /**
     * Disable kiosk mode (no-op on iOS).
     */
    actual suspend fun disableKioskMode(): Result<Unit> {
        // No-op - kiosk mode requires Guided Access or MDM on iOS
        _isKioskModeEnabled.value = false
        return Result.success(Unit)
    }
}
