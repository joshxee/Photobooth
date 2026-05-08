package com.jc.photobooth.ui.photobooth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.jc.photobooth.ui.knockbox.KnockboxAttract
import com.jc.photobooth.ui.knockbox.KnockboxCountdown
import com.jc.photobooth.ui.knockbox.KnockboxFrame
import com.jc.photobooth.ui.knockbox.KnockboxStripReview
import com.jc.photobooth.ui.knockbox.KnockboxTokens
import com.jc.photobooth.ui.knockbox.PlaceholderHues
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharedFlow

private enum class Stage { Attract, Countdown, Flash, Strip }

/**
 * Single source of truth for the photobooth flow:
 *   Attract → Countdown → Flash → Strip review → restart.
 *
 * Camera-specific wrappers supply [livePreview] + [captureFrame].
 * [startTrigger] (typically a gesture detector) advances out of Attract.
 * [errorSlot] / [overlay] are rendered above the flow.
 *
 * The [livePreview] composable stays in composition across all stages so
 * the upstream camera session keeps streaming — prevents reconnect lag and
 * allows gesture detection while strip review is on screen.
 */
@Composable
fun PhotoboothHost(
    headline: String = "Sarah & Tom's Wedding",
    date: String = "06.05.2026",
    totalShots: Int = 3,
    countdownSeconds: Int = 3,
    stripScalePortrait: Float = 1.45f,
    stripScaleLandscape: Float = 1.3f,
    livePreview: @Composable () -> Unit,
    captureFrame: suspend (Int) -> KnockboxFrame,
    startTrigger: SharedFlow<Unit>? = null,
    errorSlot: @Composable BoxScope.() -> Unit = {},
    overlay: @Composable BoxScope.() -> Unit = {},
    modifier: Modifier = Modifier
) {
    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .background(KnockboxTokens.Ink)
    ) {
        val isPortrait = maxHeight > maxWidth
        PhotoboothFlow(
            isPortrait = isPortrait,
            headline = headline,
            date = date,
            totalShots = totalShots,
            countdownSeconds = countdownSeconds,
            stripScalePortrait = stripScalePortrait,
            stripScaleLandscape = stripScaleLandscape,
            livePreview = livePreview,
            captureFrame = captureFrame,
            startTrigger = startTrigger,
            errorSlot = errorSlot,
            overlay = overlay
        )
    }
}

@Composable
private fun PhotoboothFlow(
    isPortrait: Boolean,
    headline: String,
    date: String,
    totalShots: Int,
    countdownSeconds: Int,
    stripScalePortrait: Float,
    stripScaleLandscape: Float,
    livePreview: @Composable () -> Unit,
    captureFrame: suspend (Int) -> KnockboxFrame,
    startTrigger: SharedFlow<Unit>?,
    errorSlot: @Composable BoxScope.() -> Unit,
    overlay: @Composable BoxScope.() -> Unit
) {
    var stage by remember { mutableStateOf(Stage.Attract) }
    var countdown by remember { mutableIntStateOf(countdownSeconds) }
    var shotIndex by remember { mutableIntStateOf(0) }
    var presence by remember { mutableStateOf(false) }
    val frames = remember { mutableStateListOf<KnockboxFrame>() }

    fun start() {
        frames.clear()
        shotIndex = 0
        countdown = countdownSeconds
        stage = Stage.Countdown
    }

    LaunchedEffect(stage) {
        if (stage == Stage.Attract) {
            presence = false
            delay(2200)
            presence = true
            delay(900)
            if (stage == Stage.Attract) start()
        }
    }

    LaunchedEffect(stage, startTrigger) {
        if (stage == Stage.Attract && startTrigger != null) {
            startTrigger.collect {
                if (stage == Stage.Attract) start()
            }
        }
    }

    LaunchedEffect(stage, countdown) {
        if (stage == Stage.Countdown) {
            if (countdown <= 0) {
                stage = Stage.Flash
            } else {
                delay(800)
                countdown -= 1
            }
        }
    }

    LaunchedEffect(stage) {
        if (stage == Stage.Flash) {
            val nextIndex = frames.size
            val frame = runCatching { captureFrame(nextIndex) }.getOrElse {
                KnockboxFrame(
                    hue = PlaceholderHues[nextIndex % PlaceholderHues.size],
                    label = "guest 0${nextIndex + 1}"
                )
            }
            frames.add(frame)
            shotIndex = frames.size
            if (frames.size >= totalShots) {
                stage = Stage.Strip
            } else {
                countdown = countdownSeconds
                stage = Stage.Countdown
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Box(modifier = Modifier.fillMaxSize()) {
            livePreview()
        }

        when (stage) {
            Stage.Attract -> KnockboxAttract(
                isPortrait = isPortrait,
                presence = presence,
                totalShots = totalShots,
                onStart = ::start
            )
            Stage.Countdown -> KnockboxCountdown(
                secondsRemaining = countdown,
                shotIndex = shotIndex,
                totalShots = totalShots
            )
            Stage.Flash -> Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.White)
            )
            Stage.Strip -> KnockboxStripReview(
                isPortrait = isPortrait,
                frames = frames.toList(),
                headline = headline,
                date = date,
                stripScalePortrait = stripScalePortrait,
                stripScaleLandscape = stripScaleLandscape,
                onAgain = ::start
            )
        }

        Box(modifier = Modifier.fillMaxSize().align(Alignment.Center)) { errorSlot() }
        Box(modifier = Modifier.fillMaxSize().align(Alignment.Center)) { overlay() }
    }
}
