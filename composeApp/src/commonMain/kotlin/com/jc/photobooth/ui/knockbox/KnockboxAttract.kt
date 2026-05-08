package com.jc.photobooth.ui.knockbox

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Transparent attract overlay sitting on top of the persistent live preview.
 * Dismisses on tap or when `presence` flips true. Mirrors AttractOverlayA
 * after the user's "transparent overlay, no body text" iteration.
 */
@Composable
fun KnockboxAttract(
    isPortrait: Boolean,
    presence: Boolean,
    totalShots: Int,
    onStart: () -> Unit,
    modifier: Modifier = Modifier
) {
    val targetAlpha = if (presence) 0f else 1f
    val alpha by animateFloatAsState(targetValue = targetAlpha, label = "attract-fade")

    val gradient = Brush.verticalGradient(
        colors = listOf(Color(0x3814201E), Color(0x6B14201E))
    )

    Box(
        modifier = modifier
            .fillMaxSize()
            .alpha(alpha)
            .background(gradient)
            .clickable { onStart() }
            .padding(horizontal = 60.dp, vertical = 60.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.align(Alignment.TopStart)
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(KnockboxTokens.Forest)
            )
            Text(
                text = "KNOCKBOX · PHOTOBOOTH",
                color = Color.White.copy(alpha = 0.85f),
                fontFamily = KnockboxFonts.Mono,
                fontWeight = FontWeight.Medium,
                fontSize = 12.sp,
                letterSpacing = 0.5.sp
            )
        }

        Column(
            modifier = Modifier.align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            Text(
                text = "Raise a hand or",
                color = Color.White,
                fontFamily = KnockboxFonts.Sans,
                fontWeight = FontWeight.Medium,
                fontSize = if (isPortrait) 72.sp else 84.sp,
                lineHeight = if (isPortrait) 70.sp else 82.sp,
                letterSpacing = (-2).sp,
                textAlign = TextAlign.Center
            )
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(KnockboxTokens.Paper)
                    .clickable { onStart() }
                    .padding(horizontal = 44.dp, vertical = 26.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(12.dp)
                        .clip(CircleShape)
                        .background(KnockboxTokens.Forest)
                )
                Text(
                    text = "Tap to start",
                    color = KnockboxTokens.Ink,
                    fontFamily = KnockboxFonts.Sans,
                    fontWeight = FontWeight.Medium,
                    fontSize = 26.sp
                )
            }
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            modifier = Modifier.align(Alignment.BottomCenter)
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                repeat(totalShots) {
                    Box(
                        modifier = Modifier
                            .width(28.dp)
                            .height(6.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .background(Color.White.copy(alpha = 0.85f))
                    )
                }
            }
            Text(
                text = "$totalShots SHOTS",
                color = Color.White.copy(alpha = 0.85f),
                fontFamily = KnockboxFonts.Mono,
                fontWeight = FontWeight.Medium,
                fontSize = 12.sp,
                letterSpacing = 1.8.sp
            )
        }
    }
}
