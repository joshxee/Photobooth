package com.jc.photobooth

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.jc.photobooth.camera.domain.initWiFiConnectionManagerContext
import com.jc.photobooth.data.initDataStore
import com.jc.photobooth.gesture.initGestureDetectorContext
import com.jc.photobooth.network.initNetworkMonitorContext

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Initialize DataStore
        initDataStore(applicationContext)

        // Initialize network monitor context
        initNetworkMonitorContext(applicationContext)

        // Initialize WiFi connection manager context
        initWiFiConnectionManagerContext(applicationContext)

        // Initialize gesture detector context
        initGestureDetectorContext(applicationContext)

        // Keep screen on for continuous photobooth operation
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContent {
            App()
        }
    }
}

@Preview
@Composable
fun AppAndroidPreview() {
    App()
}