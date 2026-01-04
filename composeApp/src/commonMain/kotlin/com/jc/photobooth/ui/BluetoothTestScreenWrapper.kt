package com.jc.photobooth.ui

import androidx.compose.runtime.Composable

/**
 * Platform-specific wrapper for BluetoothTestScreen.
 * This is needed because BluetoothCameraController requires a Context on Android.
 */
@Composable
expect fun BluetoothTestScreenWrapper(onBack: () -> Unit)
