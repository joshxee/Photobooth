package com.jc.photobooth.ui.knockbox

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Centered countdown overlay: top-pinned "Look at the lens ↑" + huge numeral
 * with pop animation + shot pips at bottom. The arrow gently bounces.
 */
@Composable
fun KnockboxCountdown(
    secondsRemaining: Int,
    shotIndex: Int,
    totalShots: Int,
    modifier: Modifier = Modifier
) {
    val transition = rememberInfiniteTransition(label = "arrow-bounce")
    val arrowDy by transition.animateFloat(
        initialValue = 0f,
        targetValue = -10f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 800),
            repeatMode = RepeatMode.Reverse
        ),
        label = "arrow-y"
    )

    Box(modifier = modifier.fillMaxSize()) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(listOf(Color(0x8C000000), Color(0x00000000)))
                )
                .padding(top = 32.dp, bottom = 36.dp, start = 40.dp, end = 40.dp)
                .align(Alignment.TopCenter)
        ) {
            Text(
                text = "↑",
                color = Color.White,
                fontFamily = KnockboxFonts.Sans,
                fontSize = 26.sp,
                modifier = Modifier.offset(y = arrowDy.dp)
            )
            Text(
                text = "Look at the lens",
                color = Color.White,
                fontFamily = KnockboxFonts.Sans,
                fontWeight = FontWeight.Medium,
                fontSize = 56.sp,
                lineHeight = 56.sp,
                letterSpacing = (-1.6).sp,
                textAlign = TextAlign.Center
            )
        }

        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            AnimatedContent(
                targetState = secondsRemaining,
                transitionSpec = {
                    (scaleIn(initialScale = 0.6f, animationSpec = tween(450)) + fadeIn(tween(220)))
                        .togetherWith(fadeOut(tween(180)))
                },
                label = "countdown-numeral"
            ) { n ->
                Text(
                    text = if (n > 0) n.toString() else "·",
                    color = Color.White.copy(alpha = 0.97f),
                    fontFamily = KnockboxFonts.Sans,
                    fontWeight = FontWeight.Medium,
                    fontSize = 320.sp,
                    lineHeight = 320.sp,
                    letterSpacing = (-18).sp
                )
            }
        }

        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 36.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            repeat(totalShots) { i ->
                val color = when {
                    i < shotIndex -> KnockboxTokens.Forest2
                    i == shotIndex -> Color.White.copy(alpha = 0.95f)
                    else -> Color.White.copy(alpha = 0.25f)
                }
                Box(
                    modifier = Modifier
                        .width(56.dp)
                        .height(6.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(color)
                )
            }
        }
    }
}
