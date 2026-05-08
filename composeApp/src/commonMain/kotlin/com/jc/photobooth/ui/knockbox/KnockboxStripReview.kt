package com.jc.photobooth.ui.knockbox

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
    presenceTriggerMs: Long = 4500,
    onAgain: () -> Unit,
    modifier: Modifier = Modifier
) {
    var remaining by remember { mutableStateOf(autoReturnSec * 1000L) }
    var presence by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        while (remaining > 0L) {
            delay(100)
            remaining = max(0L, remaining - 100L)
        }
        onAgain()
    }
    LaunchedEffect(Unit) {
        delay(presenceTriggerMs)
        presence = true
        delay(800)
        onAgain()
    }

    val pct = remaining.toFloat() / (autoReturnSec * 1000f)
    val secondsLabel = ceil(remaining / 1000f).toInt().coerceAtLeast(0)

    val bg = Brush.verticalGradient(listOf(KnockboxTokens.Ink, Color(0xFF11151A)))

    Box(modifier = modifier.fillMaxSize().background(bg)) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    start = if (isPortrait) 32.dp else 48.dp,
                    end = if (isPortrait) 32.dp else 48.dp,
                    top = 32.dp,
                    bottom = if (isPortrait) 96.dp else 80.dp
                ),
            horizontalArrangement = Arrangement.spacedBy(if (isPortrait) 28.dp else 48.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            StripCell(
                isPortrait = isPortrait,
                frames = frames,
                headline = headline,
                date = date,
                stripScalePortrait = stripScalePortrait,
                stripScaleLandscape = stripScaleLandscape
            )
            ReviewTextColumn(
                isPortrait = isPortrait,
                onAgain = onAgain
            )
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
                        text = if (presence) "PRESENCE DETECTED" else "RETURNING TO PHOTOBOOTH",
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
private fun RowScope.StripCell(
    isPortrait: Boolean,
    frames: List<KnockboxFrame>,
    headline: String,
    date: String,
    stripScalePortrait: Float,
    stripScaleLandscape: Float
) {
    Box(
        modifier = Modifier
            .weight(if (isPortrait) 0.0001f else 1f, fill = !isPortrait)
            .fillMaxHeight()
            .wrapContentSize(),
        contentAlignment = Alignment.Center
    ) {
        KnockboxPhotoStrip(
            frames = frames,
            headline = headline,
            date = date,
            scale = if (isPortrait) stripScalePortrait else stripScaleLandscape
        )
    }
}

@Composable
private fun RowScope.ReviewTextColumn(
    isPortrait: Boolean,
    onAgain: () -> Unit
) {
    Column(
        modifier = Modifier.weight(1f).fillMaxHeight(),
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

        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(KnockboxTokens.RadiusMedium))
                .background(Color.White.copy(alpha = 0.06f))
                .border(
                    width = 1.dp,
                    color = Color.White.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(KnockboxTokens.RadiusMedium)
                )
                .padding(horizontal = 22.dp, vertical = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(KnockboxTokens.ForestSoft),
                contentAlignment = Alignment.Center
            ) {
                Text(text = "✋", color = KnockboxTokens.Forest, fontSize = 22.sp)
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = "Want another?",
                    color = Color.White,
                    fontFamily = KnockboxFonts.Sans,
                    fontWeight = FontWeight.Medium,
                    fontSize = 18.sp
                )
                Text(
                    text = "RAISE A HAND · OR TAP BELOW",
                    color = Color.White.copy(alpha = 0.5f),
                    fontFamily = KnockboxFonts.Mono,
                    fontSize = 11.sp,
                    letterSpacing = 1.0.sp
                )
            }
        }

        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(KnockboxTokens.Paper)
                .clickable { onAgain() }
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
