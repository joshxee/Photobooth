package com.jc.photobooth.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.jc.photobooth.ui.knockbox.KnockboxFonts

/**
 * Premium serif typography for photobooth app.
 * Business card aesthetic using system serif fonts.
 *
 * Typography scale designed for:
 * - Countdown: displayLarge (72.sp) - Large but not overwhelming
 * - Screen titles: headlineMedium (28.sp)
 * - Buttons: titleMedium (16.sp)
 * - Body text: bodyMedium (14.sp)
 * - Status badges: labelSmall (11.sp)
 */
@Composable
fun photoboothTypography(): Typography = Typography(
    // Display styles: Large countdown and hero text
    displayLarge = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 72.sp,
        lineHeight = 84.sp,
        letterSpacing = 0.sp
    ),
    displayMedium = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 48.sp,
        lineHeight = 56.sp,
        letterSpacing = 0.sp
    ),
    displaySmall = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 36.sp,
        lineHeight = 44.sp,
        letterSpacing = 0.sp
    ),

    // Headline styles: Screen titles and section headers
    headlineLarge = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 32.sp,
        lineHeight = 40.sp,
        letterSpacing = 0.sp
    ),
    headlineMedium = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 28.sp,
        lineHeight = 36.sp,
        letterSpacing = 0.sp
    ),
    headlineSmall = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 24.sp,
        lineHeight = 32.sp,
        letterSpacing = 0.sp
    ),

    // Title styles: Card titles and emphasized text
    titleLarge = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.sp
    ),
    titleMedium = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.1.sp
    ),
    titleSmall = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp
    ),

    // Body styles: Main content text
    bodyLarge = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.5.sp
    ),
    bodyMedium = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.25.sp
    ),
    bodySmall = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.4.sp
    ),

    // Label styles: Buttons, badges, small text
    labelLarge = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp
    ),
    labelMedium = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.5.sp
    ),
    labelSmall = TextStyle(
        fontFamily = KnockboxFonts.Sans,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.5.sp
    )
)
