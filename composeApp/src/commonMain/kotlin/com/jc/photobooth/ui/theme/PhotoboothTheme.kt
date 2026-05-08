package com.jc.photobooth.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.jc.photobooth.ui.knockbox.KnockboxTokens

/**
 * Premium monochrome color scheme for photobooth app.
 * Business card aesthetic with black/white/gray palette.
 */
private val PhotoboothColorScheme = darkColorScheme(
    primary = KnockboxTokens.Paper,
    onPrimary = KnockboxTokens.Ink,

    surface = KnockboxTokens.Ink,
    onSurface = KnockboxTokens.Paper,

    background = KnockboxTokens.Ink,
    onBackground = KnockboxTokens.Paper,

    secondary = KnockboxTokens.Forest,
    onSecondary = KnockboxTokens.Paper,
    tertiary = KnockboxTokens.ForestSoft,
    onTertiary = KnockboxTokens.Ink,

    error = Color(0xFFE57373),
    onError = KnockboxTokens.Ink,

    surfaceContainer = Color(0xFF1A1F22),
    surfaceContainerHigh = Color(0xFF242A2D),
    surfaceContainerHighest = Color(0xFF2E3438),

    outline = Color(0xFF6E7780),
    outlineVariant = Color(0xFF3A4146)
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
        typography = photoboothTypography(),
        shapes = PhotoboothShapes,
        content = content
    )
}
