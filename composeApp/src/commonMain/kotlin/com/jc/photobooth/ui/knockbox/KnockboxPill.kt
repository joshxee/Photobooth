package com.jc.photobooth.ui.knockbox

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class KnockboxPillStyle { Paper, Outline, Ghost }

@Composable
fun KnockboxPill(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: KnockboxPillStyle = KnockboxPillStyle.Paper,
    enabled: Boolean = true,
    leadingDot: Boolean = true
) {
    val (bg, fg) = when (style) {
        KnockboxPillStyle.Paper -> KnockboxTokens.Paper to KnockboxTokens.Ink
        KnockboxPillStyle.Outline -> Color.Transparent to KnockboxTokens.Paper
        KnockboxPillStyle.Ghost -> Color.White.copy(alpha = 0.06f) to KnockboxTokens.Paper
    }
    val alpha = if (enabled) 1f else 0.35f
    val outlineMod = if (style == KnockboxPillStyle.Outline) {
        Modifier.border(
            width = 1.dp,
            color = KnockboxTokens.Paper.copy(alpha = 0.6f * alpha),
            shape = RoundedCornerShape(999.dp)
        )
    } else Modifier
    val clickMod = if (enabled) Modifier.clickable(onClick = onClick) else Modifier

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg.copy(alpha = (if (style == KnockboxPillStyle.Paper) 1f else bg.alpha) * alpha))
            .then(outlineMod)
            .then(clickMod)
            .padding(horizontal = 28.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        if (leadingDot) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(KnockboxTokens.Forest.copy(alpha = alpha))
            )
        }
        Text(
            text = label,
            color = fg.copy(alpha = alpha),
            fontFamily = KnockboxFonts.Sans,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp
        )
    }
}
