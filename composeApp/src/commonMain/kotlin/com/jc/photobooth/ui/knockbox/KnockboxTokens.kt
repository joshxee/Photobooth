package com.jc.photobooth.ui.knockbox

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Knockbox design tokens — sRGB approximations of the oklch values from
 * photobooth/project/styles/tokens.css. Almost-monochrome with forest accent.
 */
object KnockboxTokens {
    // Paper / ink
    val Paper = Color(0xFFFCFAF6)
    val Paper2 = Color(0xFFF6F2EC)
    val Paper3 = Color(0xFFECE7DD)
    val Ink = Color(0xFF1B1F22)
    val Ink2 = Color(0xFF4A4F54)
    val Ink3 = Color(0xFF7E848A)
    val Hairline = Color(0xFFDCD8D0)

    // Forest green — used sparingly
    val Forest = Color(0xFF2E5240)
    val Forest2 = Color(0xFF3D6B53)
    val ForestSoft = Color(0xFFE5EFE7)

    // Radii
    val RadiusSmall = 10.dp
    val RadiusMedium = 18.dp
    val RadiusLarge = 28.dp
    val RadiusXLarge = 40.dp
}
