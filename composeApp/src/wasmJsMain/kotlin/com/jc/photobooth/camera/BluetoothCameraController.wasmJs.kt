package com.jc.photobooth.camera

actual fun createBluetoothCameraController(): BluetoothCameraController {
    throw UnsupportedOperationException("Bluetooth camera control is only available on Android")
}
