package com.jc.photobooth.ui.photostrip

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/**
 * Circular countdown timer that displays a depleting circular progress indicator
 * with remaining seconds in the center.
 *
 * @param durationSeconds Total countdown duration in seconds
 * @param onComplete Callback invoked when countdown reaches zero
 * @param modifier Modifier for the composable
 * @param size Size of the circular timer
 * @param strokeWidth Width of the circular progress stroke
 * @param color Color of the progress indicator
 */
@Composable
fun CircularCountdownTimer(
    durationSeconds: Int = 10,
    onComplete: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 120.dp,
    strokeWidth: Dp = 8.dp,
    color: Color = MaterialTheme.colorScheme.primary
) {
    var remainingSeconds by remember { mutableIntStateOf(durationSeconds) }

    // Animate progress from 1.0 (full) to 0.0 (empty)
    val progress = remainingSeconds.toFloat() / durationSeconds.toFloat()
    val animatedProgress by animateFloatAsState(
        targetValue = progress,
        animationSpec = tween(durationMillis = 300),
        label = "countdown_progress"
    )

    // Countdown logic
    LaunchedEffect(Unit) {
        while (remainingSeconds > 0) {
            delay(1000)
            remainingSeconds--
        }
        onComplete()
    }

    Box(
        modifier = modifier.size(size),
        contentAlignment = Alignment.Center
    ) {
        // Circular progress indicator
        Canvas(modifier = Modifier.size(size)) {
            val sweepAngle = 360f * animatedProgress

            // Background circle (light gray)
            drawArc(
                color = color.copy(alpha = 0.2f),
                startAngle = -90f,
                sweepAngle = 360f,
                useCenter = false,
                style = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round)
            )

            // Progress arc (depleting clockwise from top)
            drawArc(
                color = color,
                startAngle = -90f,
                sweepAngle = sweepAngle,
                useCenter = false,
                style = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round)
            )
        }

        // Remaining seconds text
        Text(
            text = remainingSeconds.toString(),
            fontSize = 32.sp,
            fontWeight = FontWeight.Bold,
            color = color
        )
    }
}
