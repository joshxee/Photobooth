package com.jc.photobooth.camera.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.jc.photobooth.camera.domain.ConnectionState

@Composable
fun ConnectionStatusIndicator(state: ConnectionState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .background(
                    color = when (state) {
                        is ConnectionState.Connected -> Color.Green
                        is ConnectionState.Connecting -> Color.Yellow
                        is ConnectionState.Error -> Color.Red
                        is ConnectionState.Disconnected -> Color.Gray
                    },
                    shape = CircleShape
                )
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = when (state) {
                is ConnectionState.Connected -> "Connected"
                is ConnectionState.Connecting -> "Connecting"
                is ConnectionState.Error -> "Error"
                is ConnectionState.Disconnected -> "Disconnected"
            },
            style = MaterialTheme.typography.bodySmall
        )
    }
}
