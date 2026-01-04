package com.jc.photobooth.camera

import android.bluetooth.le.ScanFilter
import android.companion.AssociationRequest
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.Context
import android.util.Log

/**
 * Helper for discovering and pairing Sony cameras using Android's Companion Device API.
 *
 * Sony cameras don't appear in normal Bluetooth settings - they use manufacturer-specific
 * BLE advertisement and require the Companion Device API to discover them.
 *
 * Based on alpharemote implementation: https://github.com/Staacks/alpharemote
 * Thanks to coral for protocol documentation: https://github.com/coral/freemote
 */
object CompanionDeviceHelper {

    private const val TAG = "CompanionDeviceHelper"

    // Sony Corporation manufacturer ID
    private const val SONY_MANUFACTURER_ID = 0x012D

    /**
     * Get list of already-associated camera addresses.
     */
    fun getAssociatedCameras(context: Context): List<String> {
        val deviceManager = context.getSystemService(Context.COMPANION_DEVICE_SERVICE) as? CompanionDeviceManager
        return deviceManager?.associations ?: emptyList()
    }

    /**
     * Start pairing a Sony camera using Companion Device API.
     *
     * This will show a system dialog with discovered cameras.
     * Camera must be in pairing mode: Menu → Network → Bluetooth → Pairing
     *
     * @param context Android context
     * @param callback CompanionDeviceManager callback for pairing result
     */
    fun pairCamera(context: Context, callback: CompanionDeviceManager.Callback) {
        val deviceFilter: BluetoothLeDeviceFilter = BluetoothLeDeviceFilter.Builder()
            .setScanFilter(
                ScanFilter.Builder()
                    .setManufacturerData(
                        SONY_MANUFACTURER_ID,
                        byteArrayOf(
                            // Filter for Sony camera BLE advertisement
                            0x03.toByte(), 0x00.toByte(),               // Device type: Camera
                            0x64.toByte(),                              // Protocol version (0x64 or 0x65)
                            0x00.toByte(),                              // Reserved
                            0x00.toByte(), 0x00.toByte(),               // Model code
                            0x22.toByte(), 0x40.toByte(), 0x00.toByte() // Status (0x40 = ready to pair)
                        ),
                        byteArrayOf(
                            // Filter mask - which bytes to check
                            0xff.toByte(), 0xff.toByte(),               // Must be camera (0x0003)
                            0x00.toByte(),                              // Ignore protocol version
                            0x00.toByte(),                              // Ignore reserved
                            0x00.toByte(), 0x00.toByte(),               // Ignore model code
                            0xff.toByte(), 0x40.toByte(), 0x00.toByte() // Must be ready to pair
                        )
                    )
                    .build()
            )
            .build()

        val associationRequest: AssociationRequest = AssociationRequest.Builder()
            .addDeviceFilter(deviceFilter)
            .setSingleDevice(true)  // Only show one camera at a time
            .build()

        val deviceManager = context.getSystemService(Context.COMPANION_DEVICE_SERVICE) as? CompanionDeviceManager

        if (deviceManager == null) {
            Log.e(TAG, "CompanionDeviceManager not available")
            return
        }

        Log.d(TAG, "Starting camera discovery...")
        deviceManager.associate(associationRequest, callback, null)
    }

    /**
     * Unpair all associated cameras.
     */
    fun unpairAllCameras(context: Context) {
        val deviceManager = context.getSystemService(Context.COMPANION_DEVICE_SERVICE) as? CompanionDeviceManager

        deviceManager?.associations?.forEach { address ->
            Log.d(TAG, "Disassociating camera: $address")
            try {
                deviceManager.disassociate(address)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to disassociate $address", e)
            }
        }
    }
}
