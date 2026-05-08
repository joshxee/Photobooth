package com.jc.photobooth.ui.knockbox

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * Stand-in for live preview / captured frames.
 * Mirrors the JSX FacePlaceholder: 135° repeating-stripe pattern + mono caption.
 */
@Composable
fun KnockboxPlaceholderFace(
    hue: Float = 200f,
    label: String = "live preview",
    modifier: Modifier = Modifier
) {
    val base = hueToColor(hue, lightness = 0.78f)
    val accent = hueToColor(hue, lightness = 0.66f)

    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val stripe = 14f
            val period = stripe * 2f
            val diag = size.width + size.height
            drawRect(color = base)
            val angle = Math.toRadians(135.0)
            val dx = cos(angle).toFloat()
            val dy = sin(angle).toFloat()
            var t = -diag
            while (t < diag) {
                drawLine(
                    color = accent,
                    start = Offset(t * dx - diag * dy, t * dy + diag * dx),
                    end = Offset(t * dx + diag * dy, t * dy - diag * dx),
                    strokeWidth = stripe
                )
                t += period
            }
        }
        Text(
            text = label.uppercase(),
            color = Color.White.copy(alpha = 0.85f),
            fontFamily = KnockboxFonts.Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 11.sp,
            letterSpacing = 1.2.sp
        )
    }
}

internal fun hueToColor(hue: Float, lightness: Float = 0.7f, saturation: Float = 0.55f): Color {
    val h = ((hue % 360f) + 360f) % 360f / 60f
    val c = (1f - abs(2f * lightness - 1f)) * saturation
    val x = c * (1f - abs(h % 2f - 1f))
    val (r1, g1, b1) = when {
        h < 1f -> Triple(c, x, 0f)
        h < 2f -> Triple(x, c, 0f)
        h < 3f -> Triple(0f, c, x)
        h < 4f -> Triple(0f, x, c)
        h < 5f -> Triple(x, 0f, c)
        else -> Triple(c, 0f, x)
    }
    val m = lightness - c / 2f
    return Color(r1 + m, g1 + m, b1 + m)
}

internal val PlaceholderHues = listOf(28f, 152f, 220f, 12f, 280f, 60f)
