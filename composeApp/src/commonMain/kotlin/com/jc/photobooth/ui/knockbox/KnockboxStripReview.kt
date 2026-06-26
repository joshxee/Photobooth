package com.jc.photobooth.ui.knockbox

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlin.math.ceil
import kotlin.math.max

/**
 * Strip review surface — no live preview. Solid dark gradient, tilted strip on
 * one side, headline + "raise a hand" card + restart button on the other,
 * reverse loading bar pinned to bottom. Auto-restarts after `autoReturnSec` or
 * after simulated presence detection.
 */
@Composable
fun KnockboxStripReview(
    isPortrait: Boolean,
    frames: List<KnockboxFrame>,
    headline: String,
    date: String,
    stripScalePortrait: Float = 1.45f,
    stripScaleLandscape: Float = 1.3f,
    autoReturnSec: Int = 12,
    onAgain: () -> Unit,
    onTimeout: () -> Unit = onAgain,
    modifier: Modifier = Modifier
) {
    var remaining by remember { mutableStateOf(autoReturnSec * 1000L) }

    LaunchedEffect(Unit) {
        while (remaining > 0L) {
            delay(100)
            remaining = max(0L, remaining - 100L)
        }
        onTimeout()
    }

    val pct = remaining.toFloat() / (autoReturnSec * 1000f)
    val secondsLabel = ceil(remaining / 1000f).toInt().coerceAtLeast(0)

    val bg = Brush.verticalGradient(listOf(KnockboxTokens.Ink, Color(0xFF11151A)))

    Box(modifier = modifier.fillMaxSize().background(bg)) {
        val contentPadding = Modifier
            .fillMaxSize()
            .padding(
                start = if (isPortrait) 32.dp else 48.dp,
                end = if (isPortrait) 32.dp else 48.dp,
                top = 32.dp,
                bottom = if (isPortrait) 96.dp else 80.dp
            )
        if (isPortrait) {
            Column(
                modifier = contentPadding,
                verticalArrangement = Arrangement.spacedBy(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                StripCell(
                    frames = frames,
                    headline = headline,
                    date = date,
                    scale = stripScalePortrait,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .wrapContentSize(Alignment.Center)
                )
                ReviewTextColumn(
                    isPortrait = true,
                    onAgain = onAgain,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        } else {
            Row(
                modifier = contentPadding,
                horizontalArrangement = Arrangement.spacedBy(48.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                StripCell(
                    frames = frames,
                    headline = headline,
                    date = date,
                    scale = stripScaleLandscape,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .wrapContentSize(Alignment.Center)
                )
                ReviewTextColumn(
                    isPortrait = false,
                    onAgain = onAgain,
                    modifier = Modifier.weight(1f).fillMaxHeight()
                )
            }
        }

        // Reverse loading bar pinned to bottom
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(Color(0x40000000))
                .border(width = 1.dp, color = Color.White.copy(alpha = 0.08f))
                .padding(start = 36.dp, end = 36.dp, top = 20.dp, bottom = 22.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(KnockboxTokens.Forest)
                    )
                    Text(
                        text = "RETURNING TO PHOTOBOOTH",
                        color = Color.White.copy(alpha = 0.7f),
                        fontFamily = KnockboxFonts.Mono,
                        fontWeight = FontWeight.Medium,
                        fontSize = 11.sp,
                        letterSpacing = 1.1.sp
                    )
                }
                Text(
                    text = "${secondsLabel}s",
                    color = Color.White.copy(alpha = 0.7f),
                    fontFamily = KnockboxFonts.Mono,
                    fontWeight = FontWeight.Medium,
                    fontSize = 11.sp
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(4.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(Color.White.copy(alpha = 0.12f))
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxHeight()
                        .fillMaxWidth(fraction = pct.coerceIn(0f, 1f))
                        .background(KnockboxTokens.Forest2)
                )
            }
        }
    }
}

@Composable
private fun StripCell(
    frames: List<KnockboxFrame>,
    headline: String,
    date: String,
    scale: Float,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center
    ) {
        KnockboxPhotoStrip(
            frames = frames,
            headline = headline,
            date = date,
            scale = scale
        )
    }
}

@Composable
private fun ReviewTextColumn(
    isPortrait: Boolean,
    onAgain: () -> Unit,
    modifier: Modifier = Modifier
) {
    var buttonLoading by remember { mutableStateOf(false) }
    val fillProgress = remember { Animatable(0f) }

    LaunchedEffect(buttonLoading) {
        if (buttonLoading) {
            fillProgress.snapTo(0f)
            fillProgress.animateTo(
                targetValue = 1f,
                animationSpec = tween(durationMillis = 3000, easing = LinearEasing)
            )
            onAgain()
        }
    }

    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(18.dp),
        horizontalAlignment = Alignment.Start
    ) {
        Box(modifier = Modifier.height(if (isPortrait) 32.dp else 64.dp))
        Text(
            text = "VIRTUAL PHOTO STRIP SAVED — COPIES WILL BE AVAILABLE AFTER THE EVENT",
            color = Color.White.copy(alpha = 0.7f),
            fontFamily = KnockboxFonts.Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 12.sp,
            letterSpacing = 1.8.sp
        )
        Text(
            text = "Looking good.",
            color = Color.White,
            fontFamily = KnockboxFonts.Sans,
            fontWeight = FontWeight.Medium,
            fontSize = if (isPortrait) 44.sp else 56.sp,
            lineHeight = if (isPortrait) 44.sp else 56.sp,
            letterSpacing = (-1.6).sp
        )

        val progress = fillProgress.value
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(KnockboxTokens.Paper)
                .drawBehind {
                    if (progress > 0f) {
                        drawRect(
                            color = KnockboxTokens.Forest.copy(alpha = 0.28f),
                            size = size.copy(width = size.width * progress)
                        )
                    }
                }
                .clickable(enabled = !buttonLoading) { buttonLoading = true }
                .padding(horizontal = 28.dp, vertical = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(KnockboxTokens.Forest)
            )
            Text(
                text = "Take another strip →",
                color = KnockboxTokens.Ink,
                fontFamily = KnockboxFonts.Sans,
                fontWeight = FontWeight.Medium,
                fontSize = 17.sp
            )
        }
    }
}
