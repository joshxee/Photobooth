package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Standardized home button for photobooth screens.
 *
 * Displays a home icon that navigates back to the home screen.
 * Extracted from duplicated code in all photobooth screens.
 *
 * @param onClick Callback when home button is clicked
 * @param tint Icon color (defaults to white for visibility over camera preview)
 * @param modifier Optional modifier for positioning (typically align to TopStart with padding)
 */
@Composable
fun HomeButton(
    onClick: () -> Unit,
    tint: Color = Color.White,
    modifier: Modifier = Modifier
) {
    IconButton(
        onClick = onClick,
        modifier = modifier.padding(20.dp)
    ) {
        Icon(
            imageVector = Icons.Default.Home,
            contentDescription = "Home",
            tint = tint,
            modifier = Modifier.size(48.dp)
        )
    }
}
