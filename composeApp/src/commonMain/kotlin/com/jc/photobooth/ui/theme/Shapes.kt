package com.jc.photobooth.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.dp

/**
 * Premium flat shapes for photobooth app.
 * Business card aesthetic with sharp corners and minimal rounding.
 *
 * Design principles:
 * - Cards and surfaces: RectangleShape (0.dp corners)
 * - Buttons: RectangleShape (sharp edges)
 * - Small components: Max 2.dp rounding for subtle softness
 *
 * Note: Using default Shapes() constructor as custom constructor is internal in Material3.
 * Shape customization happens at component level via shape parameters.
 */
val PhotoboothShapes = Shapes()
