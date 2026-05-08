package com.jc.photobooth.ui.knockbox

import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import photobooth.composeapp.generated.resources.Res
import photobooth.composeapp.generated.resources.geist_medium
import photobooth.composeapp.generated.resources.geist_mono_medium
import photobooth.composeapp.generated.resources.geist_mono_regular
import photobooth.composeapp.generated.resources.geist_regular
import photobooth.composeapp.generated.resources.geist_semibold
import org.jetbrains.compose.resources.Font

/**
 * Knockbox typography: Geist (sans) + Geist Mono — matches Photobooth.html
 * design tokens (`--sans` / `--mono`).
 */
object KnockboxFonts {
    val Sans: FontFamily
        @Composable
        get() = FontFamily(
            Font(Res.font.geist_regular, weight = FontWeight.Normal),
            Font(Res.font.geist_medium, weight = FontWeight.Medium),
            Font(Res.font.geist_semibold, weight = FontWeight.SemiBold)
        )

    val Mono: FontFamily
        @Composable
        get() = FontFamily(
            Font(Res.font.geist_mono_regular, weight = FontWeight.Normal),
            Font(Res.font.geist_mono_medium, weight = FontWeight.Medium)
        )
}
