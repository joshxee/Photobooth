package com.jc.photobooth.camera

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.content.getSystemService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.experimental.and
import kotlin.experimental.or

/**
 * Android implementation of BluetoothCameraController using Bluetooth Low Energy (BLE).
 *
 * This implementation is based on Sony's BLE remote control protocol as documented by:
 * - https://github.com/coral/freemote
 * - https://gregleeds.com/reverse-engineering-sony-camera-bluetooth/
 * - https://github.com/Staacks/alpharemote
 */
@SuppressLint("MissingPermission") // Permissions should be checked by the caller
class AndroidBluetoothCameraController(
    private val context: Context
) : BluetoothCameraController {

    companion object {
        private const val TAG = "BluetoothCamera"

        // Sony manufacturer ID for BLE advertisement
        private const val SONY_MANUFACTURER_ID = 0x012D

        // BLE Service and Characteristic UUIDs for Sony camera remote control
        private val REMOTE_SERVICE_UUID = UUID.fromString("8000ff00-ff00-ffff-ffff-ffffffffffff")
        private val COMMAND_CHARACTERISTIC_UUID = UUID.fromString("0000ff01-0000-1000-8000-00805f9b34fb")
        private val STATUS_CHARACTERISTIC_UUID = UUID.fromString("0000ff02-0000-1000-8000-00805f9b34fb")
        private val GENERIC_ACCESS_SERVICE_UUID = UUID.fromString("00001800-0000-1000-8000-00805f9b34fb")
        private val NAME_CHARACTERISTIC_UUID = UUID.fromString("00002a00-0000-1000-8000-00805f9b34fb")
        private val CONFIG_DESCRIPTOR_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        // Sony BLE Protocol button codes
        private const val BUTTON_SHUTTER_HALF: Byte = 0x06
        private const val BUTTON_SHUTTER_FULL: Byte = 0x08
        private const val BUTTON_RECORD: Byte = 0x0e
        private const val BUTTON_AF_ON: Byte = 0x14

        // Status notification types
        private const val STATUS_FOCUS: Byte = 0x3f.toByte()
        private const val STATUS_SHUTTER: Byte = 0xa0.toByte()
        private const val STATUS_RECORDING: Byte = 0xd5.toByte()
        private const val STATUS_BIT_READY: Byte = 0x20
    }

    private val bluetoothManager: BluetoothManager? = context.getSystemService()
    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter

    private var gatt: BluetoothGatt? = null
    private var commandCharacteristic: BluetoothGattCharacteristic? = null
    private var statusCharacteristic: BluetoothGattCharacteristic? = null

    private val operationQueue = ConcurrentLinkedQueue<BleOperation>()
    private var currentOperation: BleOperation? = null

    private val _cameraState = MutableStateFlow<BluetoothCameraState>(BluetoothCameraState.Disconnected)
    override val cameraState: StateFlow<BluetoothCameraState> = _cameraState.asStateFlow()

    private val _cameraStatus = MutableStateFlow(BluetoothCameraStatus())
    override val cameraStatus: StateFlow<BluetoothCameraStatus> = _cameraStatus.asStateFlow()

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            result?.let {
                Log.d(TAG, "Found device: ${it.device.name} (${it.device.address})")
                // Auto-scan could be implemented here
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e(TAG, "Scan failed with error: $errorCode")
            _cameraState.value = BluetoothCameraState.Error("Scan failed: $errorCode")
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt?, status: Int, newState: Int) {
            Log.d(TAG, "Connection state changed: status=$status, newState=$newState")
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    Log.d(TAG, "Connected to GATT server")
                    _cameraState.value = BluetoothCameraState.Connecting
                    gatt?.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    Log.d(TAG, "Disconnected from GATT server")
                    handleDisconnect()
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt?, status: Int) {
            Log.d(TAG, "Services discovered: status=$status")
            if (status == BluetoothGatt.GATT_SUCCESS) {
                val remoteService = gatt?.getService(REMOTE_SERVICE_UUID)
                commandCharacteristic = remoteService?.getCharacteristic(COMMAND_CHARACTERISTIC_UUID)
                statusCharacteristic = remoteService?.getCharacteristic(STATUS_CHARACTERISTIC_UUID)

                if (commandCharacteristic != null && statusCharacteristic != null) {
                    // Read camera name
                    val nameService = gatt?.getService(GENERIC_ACCESS_SERVICE_UUID)
                    val nameCharacteristic = nameService?.getCharacteristic(NAME_CHARACTERISTIC_UUID)

                    nameCharacteristic?.let { char ->
                        enqueueOperation(BleReadOperation(char) { success, value ->
                            if (success) {
                                val deviceName = value.toString(Charsets.UTF_8)
                                Log.d(TAG, "Camera name: $deviceName")
                                _cameraState.value = BluetoothCameraState.Connected(deviceName)
                            }
                        })
                    }

                    // Subscribe to status notifications
                    statusCharacteristic?.let { char ->
                        enqueueOperation(BleSubscribeOperation(char))
                    }
                } else {
                    Log.e(TAG, "Required characteristics not found")
                    _cameraState.value = BluetoothCameraState.Error("Required characteristics not found")
                    gatt?.disconnect()
                }
            } else {
                Log.e(TAG, "Service discovery failed")
                _cameraState.value = BluetoothCameraState.Error("Service discovery failed")
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt?,
            characteristic: BluetoothGattCharacteristic?,
            status: Int
        ) {
            Log.d(TAG, "Characteristic write complete: status=$status")
            if (currentOperation is BleWriteOperation) {
                (currentOperation as? BleWriteOperation)?.callback?.invoke(status == BluetoothGatt.GATT_SUCCESS)
                completeOperation()

                // Error code 144 (0x90) means remote control is disabled in camera settings
                if (status == 144) {
                    _cameraState.value = BluetoothCameraState.RemoteDisabled
                }
            }
        }

        @Deprecated("Deprecated in Java")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            handleCharacteristicRead(status, characteristic.value)
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            handleCharacteristicRead(status, value)
        }

        @Deprecated("Deprecated in Java")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            if (characteristic == statusCharacteristic) {
                handleStatusUpdate(characteristic.value)
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            if (characteristic == statusCharacteristic) {
                handleStatusUpdate(value)
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt?,
            descriptor: BluetoothGattDescriptor?,
            status: Int
        ) {
            Log.d(TAG, "Descriptor write complete: status=$status")
            if (currentOperation is BleSubscribeOperation) {
                completeOperation()
            }
        }
    }

    private fun handleCharacteristicRead(status: Int, value: ByteArray) {
        Log.d(TAG, "Characteristic read: status=$status")
        if (currentOperation is BleReadOperation) {
            (currentOperation as? BleReadOperation)?.callback?.invoke(
                status == BluetoothGatt.GATT_SUCCESS,
                value
            )
            completeOperation()
        }
    }

    private fun handleStatusUpdate(value: ByteArray) {
        if (value.size < 3) return

        Log.d(TAG, "Status update: ${value.joinToString(" ") { "%02x".format(it) }}")

        val currentStatus = _cameraStatus.value
        _cameraStatus.value = when (value[1]) {
            STATUS_FOCUS -> currentStatus.copy(
                focusAcquired = (value[2].and(STATUS_BIT_READY)) != 0.toByte()
            )
            STATUS_SHUTTER -> currentStatus.copy(
                shutterReady = (value[2].and(STATUS_BIT_READY)) != 0.toByte()
            )
            STATUS_RECORDING -> currentStatus.copy(
                recording = (value[2].and(STATUS_BIT_READY)) != 0.toByte()
            )
            else -> currentStatus
        }
    }

    private fun handleDisconnect() {
        _cameraState.value = BluetoothCameraState.Disconnected
        _cameraStatus.value = BluetoothCameraStatus()
        commandCharacteristic = null
        statusCharacteristic = null
        operationQueue.clear()
        currentOperation = null
    }

    @Synchronized
    private fun enqueueOperation(operation: BleOperation) {
        operationQueue.add(operation)
        if (currentOperation == null) {
            executeNextOperation()
        }
    }

    @Synchronized
    private fun executeNextOperation() {
        if (currentOperation != null) return

        currentOperation = operationQueue.poll() ?: return
        val gatt = this.gatt ?: return

        try {
            when (val op = currentOperation) {
                is BleWriteOperation -> {
                    Log.d(TAG, "Writing: ${op.data.joinToString(" ") { "%02x".format(it) }}")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        gatt.writeCharacteristic(
                            op.characteristic,
                            op.data,
                            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        op.characteristic.value = op.data
                        @Suppress("DEPRECATION")
                        gatt.writeCharacteristic(op.characteristic)
                    }
                }
                is BleReadOperation -> {
                    Log.d(TAG, "Reading from: ${op.characteristic.uuid}")
                    gatt.readCharacteristic(op.characteristic)
                }
                is BleSubscribeOperation -> {
                    Log.d(TAG, "Subscribing to: ${op.characteristic.uuid}")
                    gatt.setCharacteristicNotification(op.characteristic, true)
                    val descriptor = op.characteristic.getDescriptor(CONFIG_DESCRIPTOR_UUID)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                    } else {
                        @Suppress("DEPRECATION")
                        descriptor?.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        gatt.writeDescriptor(descriptor)
                    }
                }
                null -> {
                    Log.w(TAG, "Null operation in executeNextOperation")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Operation execution failed", e)
            _cameraState.value = BluetoothCameraState.Error("Operation failed", e)
            completeOperation()
        }
    }

    @Synchronized
    private fun completeOperation() {
        currentOperation = null
        executeNextOperation()
    }

    override suspend fun startScanning() {
        val scanner = bluetoothAdapter?.bluetoothLeScanner
        if (scanner == null) {
            _cameraState.value = BluetoothCameraState.Error("Bluetooth not available")
            return
        }

        val scanSettings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        // Filter for Sony devices (manufacturer ID 0x012D)
        val scanFilters = listOf(
            ScanFilter.Builder()
                .setManufacturerData(SONY_MANUFACTURER_ID, byteArrayOf())
                .build()
        )

        scanner.startScan(scanFilters, scanSettings, scanCallback)
        Log.d(TAG, "Started scanning for Sony cameras")
    }

    override fun stopScanning() {
        bluetoothAdapter?.bluetoothLeScanner?.stopScan(scanCallback)
        Log.d(TAG, "Stopped scanning")
    }

    override suspend fun connect(address: String) {
        val device = bluetoothAdapter?.getRemoteDevice(address)
        if (device == null) {
            _cameraState.value = BluetoothCameraState.Error("Device not found")
            return
        }

        if (device.bondState != BluetoothDevice.BOND_BONDED) {
            _cameraState.value = BluetoothCameraState.NotPaired
            return
        }

        _cameraState.value = BluetoothCameraState.Connecting
        gatt = device.connectGatt(context, true, gattCallback)
    }

    override fun disconnect() {
        gatt?.disconnect()
        gatt?.close()
        gatt = null
        handleDisconnect()
    }

    override suspend fun triggerShutter(waitForFocus: Boolean) {
        // Full shutter sequence: half -> full -> full up -> half up
        pressShutter(halfPress = true)
        kotlinx.coroutines.delay(100) // Small delay for half-press

        if (waitForFocus) {
            // Wait for focus confirmation (could add timeout)
            var attempts = 0
            while (!_cameraStatus.value.focusAcquired && attempts < 50) {
                kotlinx.coroutines.delay(100)
                attempts++
            }
        }

        pressShutter(halfPress = false)
        kotlinx.coroutines.delay(100) // Hold full press

        releaseShutter(halfPress = true)
        kotlinx.coroutines.delay(50)

        releaseShutter(halfPress = false)
    }

    override suspend fun pressShutter(halfPress: Boolean) {
        val code = if (halfPress) BUTTON_SHUTTER_HALF else BUTTON_SHUTTER_FULL
        sendCommand(code, pressed = true)
    }

    override suspend fun releaseShutter(halfPress: Boolean) {
        val code = if (halfPress) BUTTON_SHUTTER_HALF else BUTTON_SHUTTER_FULL
        sendCommand(code, pressed = false)
    }

    override suspend fun toggleRecording() {
        sendCommand(BUTTON_RECORD, pressed = true)
        kotlinx.coroutines.delay(50)
        sendCommand(BUTTON_RECORD, pressed = false)
    }

    override suspend fun triggerAutofocus() {
        sendCommand(BUTTON_AF_ON, pressed = true)
        kotlinx.coroutines.delay(50)
        sendCommand(BUTTON_AF_ON, pressed = false)
    }

    private suspend fun sendCommand(buttonCode: Byte, pressed: Boolean): Unit =
        suspendCancellableCoroutine { continuation ->
            val characteristic = commandCharacteristic
            if (characteristic == null) {
                if (continuation.isActive) {
                    continuation.resumeWithException(IllegalStateException("Not connected"))
                }
                return@suspendCancellableCoroutine
            }

            val code = buttonCode or (if (pressed) 0x01 else 0x00)
            val data = byteArrayOf(0x01, code)

            enqueueOperation(BleWriteOperation(characteristic, data) { success ->
                if (continuation.isActive) {
                    if (success) {
                        continuation.resume(Unit)
                    } else {
                        continuation.resumeWithException(IllegalStateException("Command failed"))
                    }
                }
            })
        }

    override fun release() {
        stopScanning()
        disconnect()
    }
}

// BLE Operation types for queue management
private sealed class BleOperation

private data class BleWriteOperation(
    val characteristic: BluetoothGattCharacteristic,
    val data: ByteArray,
    val callback: (Boolean) -> Unit
) : BleOperation()

private data class BleReadOperation(
    val characteristic: BluetoothGattCharacteristic,
    val callback: (Boolean, ByteArray) -> Unit
) : BleOperation()

private data class BleSubscribeOperation(
    val characteristic: BluetoothGattCharacteristic
) : BleOperation()

actual fun createBluetoothCameraController(): BluetoothCameraController {
    // This requires a Context - we'll need to pass it from the Android app
    throw UnsupportedOperationException("Use AndroidBluetoothCameraController(context) directly on Android")
}
