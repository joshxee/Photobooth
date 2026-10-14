package app.tauri.photoboothcamera

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class UsbDeviceArgs {
    lateinit var deviceName: String
}

@InvokeArg
class StartPreviewArgs {
    /** "front" or "back". */
    var facing: String = "front"

    /** Whether the guest should see a mirror image. */
    var mirror: Boolean = true

    /** Reserved: render the preview in a window rather than fullscreen. */
    var windowed: Boolean = false
}

@InvokeArg
class RegionArgs {
    var x: Float = 0f
    var y: Float = 0f
    var w: Float = 1f
    var h: Float = 1f
}

@InvokeArg
class GestureArgs {
    /** A live-view JPEG, base64-encoded. */
    lateinit var frame: String

    /** Where to look: the guest's box, as fractions of the frame. */
    lateinit var region: RegionArgs
}

@InvokeArg
class FlagArgs {
    var on: Boolean = false
}

/**
 * Camera and USB host for the Photobooth app.
 *
 * - The device camera is previewed with CameraX in a view placed *behind* the (transparent)
 *   WebView, the same approach as Tauri's official barcode-scanner plugin.
 * - The Sony camera is reached by handing Rust a USB file descriptor; see the contract on
 *   [usbOpen]/[usbClose].
 *
 * Camera and USB commands are called from Rust only; the WebView can reach just the window
 * helpers and the listener table (see the plugin's permissions).
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.CAMERA], alias = "camera"),
    ],
)
class PhotoboothCameraPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private val usbManager: UsbManager by lazy {
        activity.getSystemService(Context.USB_SERVICE) as UsbManager
    }
    private val mainExecutor by lazy { ContextCompat.getMainExecutor(activity) }

    private class OpenDevice(
        val connection: UsbDeviceConnection,
        /** A dup of the connection's fd; closed in [closeDevice], after Rust dropped its transport. */
        val descriptor: ParcelFileDescriptor,
    )

    private val openDevices = mutableMapOf<String, OpenDevice>()
    private val pendingPermission = mutableMapOf<String, Invoke>()
    private var usbReceiver: BroadcastReceiver? = null
    private var backCallback: OnBackPressedCallback? = null

    /** Recognizing is slow and stateful; one thread, one call at a time, off the bridge thread. */
    private val gestureExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val palmFinder by lazy { PalmFinder(activity.applicationContext) }

    private var previewView: PreviewView? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var imageCapture: ImageCapture? = null

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        activity.runOnUiThread {
            registerUsbReceiver()
            registerBackHandler()
        }
    }

    override fun onDestroy(activity: androidx.appcompat.app.AppCompatActivity) {
        super.onDestroy(activity)
        usbReceiver?.let { runCatching { activity.unregisterReceiver(it) } }
        usbReceiver = null
        backCallback?.remove()
        backCallback = null
        runCatching { tearDownPreview() }
        gestureExecutor.execute { palmFinder.close() }
        gestureExecutor.shutdown()
        openDevices.values.toList().forEach { closeDevice(it) }
        openDevices.clear()
    }

    // ---------------------------------------------------------------------------------------
    // Gesture start
    // ---------------------------------------------------------------------------------------

    /**
     * Looks for an open palm inside `region` of one live-view JPEG. Resolves `{palm}` with the
     * palm's box as fractions of the whole frame, or `{}` when there is none. Rust decides what
     * a held palm means; this only finds hands.
     */
    @Command
    fun gestureDetect(invoke: Invoke) {
        val args = invoke.parseArgs(GestureArgs::class.java)
        gestureExecutor.execute {
            try {
                val jpeg = android.util.Base64.decode(args.frame, android.util.Base64.DEFAULT)
                val region = FrameRegion(args.region.x, args.region.y, args.region.w, args.region.h)
                val palm = palmFinder.find(jpeg, region)
                val result = JSObject()
                if (palm != null) {
                    val box = JSObject()
                    box.put("x", palm.x.toDouble())
                    box.put("y", palm.y.toDouble())
                    box.put("w", palm.w.toDouble())
                    box.put("h", palm.h.toDouble())
                    result.put("palm", box)
                }
                invoke.resolve(result)
            } catch (e: Exception) {
                Log.w(TAG, "gesture detection failed", e)
                invoke.reject("Gesture detection failed: ${e.message}", e)
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // Window behaviour
    // ---------------------------------------------------------------------------------------

    @Command
    fun windowSetKeepScreenOn(invoke: Invoke) {
        val args = invoke.parseArgs(FlagArgs::class.java)
        activity.runOnUiThread {
            if (args.on) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            invoke.resolve()
        }
    }

    @Command
    fun windowSetImmersive(invoke: Invoke) {
        val args = invoke.parseArgs(FlagArgs::class.java)
        activity.runOnUiThread {
            val window = activity.window
            WindowCompat.setDecorFitsSystemWindows(window, !args.on)
            val controller = WindowInsetsControllerCompat(window, window.decorView)
            if (args.on) {
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                controller.show(WindowInsetsCompat.Type.systemBars())
            }
            invoke.resolve()
        }
    }

    /** The hardware back button must leave the booth, not close the activity. */
    private fun registerBackHandler() {
        val owner = activity as? ComponentActivity ?: return
        val callback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                trigger("backPressed", JSObject())
            }
        }
        owner.onBackPressedDispatcher.addCallback(owner, callback)
        backCallback = callback
    }

    // ---------------------------------------------------------------------------------------
    // USB host (Sony camera)
    // ---------------------------------------------------------------------------------------

    private fun usbDeviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    private fun deviceJson(device: UsbDevice): JSObject {
        val json = JSObject()
        json.put("deviceName", device.deviceName)
        json.put("vendorId", device.vendorId)
        json.put("productId", device.productId)
        device.productName?.let { json.put("productName", it) }
        json.put("hasPermission", usbManager.hasPermission(device))
        return json
    }

    private fun registerUsbReceiver() {
        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val device = usbDeviceExtra(intent) ?: return
                when (intent.action) {
                    ACTION_USB_PERMISSION -> {
                        val granted =
                            intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                        val result = JSObject()
                        result.put("granted", granted)
                        pendingPermission.remove(device.deviceName)?.resolve(result)
                    }
                    UsbManager.ACTION_USB_DEVICE_ATTACHED ->
                        if (device.vendorId == SONY_VENDOR_ID) trigger("usbAttached", deviceJson(device))
                    UsbManager.ACTION_USB_DEVICE_DETACHED ->
                        if (device.vendorId == SONY_VENDOR_ID) trigger("usbDetached", deviceJson(device))
                }
            }
        }
        // NOT_EXPORTED: only this app (our permission PendingIntent) and system broadcasts.
        ContextCompat.registerReceiver(
            activity,
            receiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        usbReceiver = receiver
    }

    /** Lists attached Sony (vendor 0x054C) devices. */
    @Command
    fun usbList(invoke: Invoke) {
        val devices = JSArray()
        for (device in usbManager.deviceList.values) {
            if (device.vendorId == SONY_VENDOR_ID) devices.put(deviceJson(device))
        }
        val result = JSObject()
        result.put("devices", devices)
        invoke.resolve(result)
    }

    /** Shows Android's USB permission dialog if needed; resolves `{granted}` when answered. */
    @Command
    fun usbRequestPermission(invoke: Invoke) {
        val args = invoke.parseArgs(UsbDeviceArgs::class.java)
        val device = usbManager.deviceList[args.deviceName]
            ?: return invoke.reject("USB device ${args.deviceName} is not attached")

        if (usbManager.hasPermission(device)) {
            val result = JSObject()
            result.put("granted", true)
            invoke.resolve(result)
            return
        }
        // A newer request supersedes an older one for the same device.
        pendingPermission.put(device.deviceName, invoke)?.reject("Superseded by a newer request")

        // Android adds extras to this PendingIntent, so it must be mutable; since API 34 a mutable
        // PendingIntent must be explicit, hence setPackage.
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val intent = Intent(ACTION_USB_PERMISSION).setPackage(activity.packageName)
        usbManager.requestPermission(device, PendingIntent.getBroadcast(activity, 0, intent, flags))
    }

    /**
     * Opens the device and resolves `{fd}`: a **duplicate** of the descriptor inside the
     * `UsbDeviceConnection`.
     *
     * Contract with the Rust side: libusb's `open_device_with_fd` does not take ownership of the
     * fd, and the USB permission grant lives on the `UsbDeviceConnection` object, not on the fd
     * number. So Rust must drop its transport *before* calling [usbClose]; closing the connection
     * first makes later libusb calls fail even though the integer is still open.
     */
    @Command
    fun usbOpen(invoke: Invoke) {
        val args = invoke.parseArgs(UsbDeviceArgs::class.java)
        val device = usbManager.deviceList[args.deviceName]
            ?: return invoke.reject("USB device ${args.deviceName} is not attached")
        if (!usbManager.hasPermission(device)) {
            return invoke.reject("USB permission has not been granted for ${args.deviceName}")
        }

        openDevices.remove(args.deviceName)?.let { closeDevice(it) }
        val connection = usbManager.openDevice(device)
            ?: return invoke.reject("Android could not open ${args.deviceName}")
        val descriptor = try {
            ParcelFileDescriptor.fromFd(connection.fileDescriptor)
        } catch (e: Exception) {
            connection.close()
            return invoke.reject("Could not duplicate the USB file descriptor: ${e.message}", e)
        }
        openDevices[args.deviceName] = OpenDevice(connection, descriptor)

        val result = JSObject()
        result.put("fd", descriptor.fd)
        invoke.resolve(result)
    }

    /** Closes the duplicate and the connection. Call only after Rust dropped its transport. */
    @Command
    fun usbClose(invoke: Invoke) {
        val args = invoke.parseArgs(UsbDeviceArgs::class.java)
        openDevices.remove(args.deviceName)?.let { closeDevice(it) }
        invoke.resolve()
    }

    private fun closeDevice(device: OpenDevice) {
        runCatching { device.descriptor.close() }
        runCatching { device.connection.close() }
    }

    // ---------------------------------------------------------------------------------------
    // Device camera (CameraX behind the WebView)
    // ---------------------------------------------------------------------------------------

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Binds CameraX `Preview` + `ImageCapture` to the activity lifecycle and shows the preview in
     * a view behind the WebView, which is made transparent.
     */
    @Command
    fun camStartPreview(invoke: Invoke) {
        val args = invoke.parseArgs(StartPreviewArgs::class.java)
        if (!hasCameraPermission()) {
            return invoke.reject("Camera permission has not been granted")
        }
        activity.runOnUiThread {
            val future = ProcessCameraProvider.getInstance(activity)
            future.addListener(
                {
                    try {
                        bindPreview(future.get(), args)
                        invoke.resolve()
                    } catch (e: Exception) {
                        Log.e(TAG, "could not start the preview", e)
                        invoke.reject("Could not start the camera preview: ${e.message}", e)
                    }
                },
                mainExecutor,
            )
        }
    }

    private fun bindPreview(provider: ProcessCameraProvider, args: StartPreviewArgs) {
        tearDownPreview()
        val web = webView ?: throw IllegalStateException("the WebView is not ready")
        val parent = web.parent as? ViewGroup
            ?: throw IllegalStateException("the WebView has no parent view")

        val front = args.facing != "back"
        val view = PreviewView(activity).apply {
            // TextureView composites correctly under a transparent WebView.
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            // PreviewView already mirrors a front camera; flip only if the request differs.
            scaleX = if (args.mirror == front) 1f else -1f
        }
        parent.addView(view, 0) // behind the WebView
        web.setBackgroundColor(Color.TRANSPARENT)
        web.bringToFront()

        val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
        val capture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()
        val selector =
            if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
        provider.bindToLifecycle(activity as LifecycleOwner, selector, preview, capture)

        previewView = view
        imageCapture = capture
        cameraProvider = provider
    }

    private fun tearDownPreview() {
        cameraProvider?.unbindAll()
        previewView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        previewView = null
        imageCapture = null
    }

    @Command
    fun camStopPreview(invoke: Invoke) {
        activity.runOnUiThread {
            tearDownPreview()
            invoke.resolve()
        }
    }

    /**
     * Takes a picture and resolves `{path, width, height}`. The file stays in the cache dir until
     * the caller reads and deletes it — raw bytes never go through JSON IPC. CameraX writes the
     * correct EXIF orientation; no manual rotation is done.
     */
    @Command
    fun camCapture(invoke: Invoke) {
        val capture = imageCapture
            ?: return invoke.reject("The camera preview has not been started")
        val file = File.createTempFile("photobooth-", ".jpg", activity.cacheDir)
        val options = ImageCapture.OutputFileOptions.Builder(file).build()

        activity.runOnUiThread {
            capture.takePicture(
                options,
                mainExecutor,
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                        // Reading the header is I/O; keep it off the main thread.
                        Thread {
                            try {
                                val (width, height) = displayedSize(file)
                                val result = JSObject()
                                result.put("path", file.absolutePath)
                                result.put("width", width)
                                result.put("height", height)
                                invoke.resolve(result)
                            } catch (e: Exception) {
                                file.delete()
                                invoke.reject("Could not read the captured photo: ${e.message}", e)
                            }
                        }.start()
                    }

                    override fun onError(exception: ImageCaptureException) {
                        file.delete()
                        Log.e(TAG, "capture failed", exception)
                        invoke.reject("Capture failed: ${exception.message}", exception)
                    }
                },
            )
        }
    }

    /** Pixel size as displayed: width/height swap when EXIF says the image is rotated 90°/270°. */
    private fun displayedSize(file: File): Pair<Int, Int> {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        val orientation = ExifInterface(file.absolutePath)
            .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        return when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90,
            ExifInterface.ORIENTATION_ROTATE_270,
            ExifInterface.ORIENTATION_TRANSPOSE,
            ExifInterface.ORIENTATION_TRANSVERSE,
            -> bounds.outHeight to bounds.outWidth
            else -> bounds.outWidth to bounds.outHeight
        }
    }

    companion object {
        private const val TAG = "PhotoboothCamera"
        private const val SONY_VENDOR_ID = 0x054C
        private const val ACTION_USB_PERMISSION = "com.jc.photobooth.USB_PERMISSION"
    }
}
