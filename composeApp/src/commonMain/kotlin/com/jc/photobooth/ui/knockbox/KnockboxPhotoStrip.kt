package com.jc.photobooth.ui.knockbox

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

data class KnockboxFrame(
    val hue: Float = 200f,
    val label: String = "",
    val image: ImageBitmap? = null
)

/**
 * Vertical 3- or 4-up photo strip with white border, tilt, and soft drop-shadow.
 * `scale` lets callers tune portrait vs. landscape (mirrors the Tweaks panel
 * sliders in Photobooth.html).
 */
@Composable
fun KnockboxPhotoStrip(
    frames: List<KnockboxFrame>,
    headline: String,
    date: String,
    scale: Float = 1f,
    rotateDegrees: Float = -3f,
    modifier: Modifier = Modifier
) {
    val widthDp = (220f * scale).dp
    val photoH = (150f * scale).dp
    val pad = (14f * scale).dp
    val padBottom = (22f * scale).dp
    val gap = (10f * scale).dp
    val radius = (6f * scale).dp
    val photoRadius = (2f * scale).dp
    val metaSize = (10f * scale).sp

    Box(
        modifier = modifier
            .rotate(rotateDegrees)
            .shadow(
                elevation = (30f * scale).dp,
                shape = RoundedCornerShape(radius),
                clip = false
            )
            .width(widthDp)
            .clip(RoundedCornerShape(radius))
            .background(Color.White)
            .padding(start = pad, end = pad, top = pad, bottom = padBottom)
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(gap),
            modifier = Modifier.fillMaxWidth()
        ) {
            frames.forEach { frame ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(photoH)
                        .clip(RoundedCornerShape(photoRadius))
                ) {
                    val img = frame.image
                    if (img != null) {
                        Image(
                            bitmap = img,
                            contentDescription = frame.label,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize()
                        )
                    } else {
                        KnockboxPlaceholderFace(hue = frame.hue, label = frame.label)
                    }
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = (4f * scale).dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Bottom
            ) {
                Text(
                    text = headline.uppercase(),
                    color = Color(0xFF3A3A3A),
                    fontFamily = KnockboxFonts.Mono,
                    fontWeight = FontWeight.Medium,
                    fontSize = metaSize,
                    letterSpacing = 0.6.sp
                )
                Text(
                    text = date,
                    color = Color(0xFF3A3A3A),
                    fontFamily = KnockboxFonts.Mono,
                    fontWeight = FontWeight.Medium,
                    fontSize = metaSize,
                    letterSpacing = 0.6.sp
                )
            }
        }
    }
}
