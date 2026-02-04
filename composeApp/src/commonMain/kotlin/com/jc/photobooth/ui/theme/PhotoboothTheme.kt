package com.jc.photobooth.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Premium monochrome color scheme for photobooth app.
 * Business card aesthetic with black/white/gray palette.
 */
private val PhotoboothColorScheme = darkColorScheme(
    // Primary colors: Pure white on black
    primary = Color(0xFFFFFFFF),
    onPrimary = Color(0xFF000000),

    // Surface colors: Dark gray background (prevents OLED burn-in)
    surface = Color(0xFF0A0A0A),
    onSurface = Color(0xFFFFFFFF),

    // Background colors: Dark gray
    background = Color(0xFF0A0A0A),
    onBackground = Color(0xFFFFFFFF),

    // Grayscale accents
    secondary = Color(0xFF808080),
    onSecondary = Color(0xFFFFFFFF),
    tertiary = Color(0xFFCCCCCC),
    onTertiary = Color(0xFF000000),

    // Error colors: Grayscale (no red)
    error = Color(0xFFCCCCCC),
    onError = Color(0xFF000000),

    // Container colors: Slightly lighter than background
    surfaceContainer = Color(0xFF1A1A1A),
    surfaceContainerHigh = Color(0xFF2A2A2A),
    surfaceContainerHighest = Color(0xFF3A3A3A),

    // Borders and outlines
    outline = Color(0xFF808080),
    outlineVariant = Color(0xFF4A4A4A)
)

/**
 * Premium photobooth theme with monochrome palette and serif typography.
 *
 * Design principles:
 * - Flat design: All elevations set to 0.dp
 * - Sharp corners: RectangleShape or max 2.dp rounding
 * - Serif typography: Business card aesthetic
 * - Minimal ornamentation: Text-first, icons only where needed
 */
@Composable
fun PhotoboothTheme(
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = PhotoboothColorScheme,
        typography = PhotoboothTypography,
        shapes = PhotoboothShapes,
        content = content
    )
}
