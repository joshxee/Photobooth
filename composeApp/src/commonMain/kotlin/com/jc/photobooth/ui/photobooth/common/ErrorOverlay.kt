package com.jc.photobooth.ui.photobooth.common

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Error overlay for photobooth screens.
 *
 * Displays an error message in a card with dismiss/retry actions.
 * Generalized from different error handling implementations across photobooth screens.
 *
 * @param message Error message to display
 * @param onDismiss Callback when dismiss/cancel button is clicked
 * @param onRetry Optional callback for retry action (if null, only dismiss button shown)
 * @param helperText Optional helper text with additional guidance
 */
@Composable
fun ErrorOverlay(
    message: String,
    onDismiss: () -> Unit,
    onRetry: (() -> Unit)? = null,
    helperText: String? = null,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.BottomCenter
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.errorContainer
            )
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "Error",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    textAlign = TextAlign.Center
                )

                if (helperText != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = helperText,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onErrorContainer.copy(alpha = 0.7f),
                        textAlign = TextAlign.Center
                    )
                }

                Spacer(modifier = Modifier.height(16.dp))

                if (onRetry != null) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        OutlinedButton(onClick = onDismiss) {
                            Text("Cancel")
                        }
                        Button(onClick = onRetry) {
                            Text("Retry")
                        }
                    }
                } else {
                    Button(onClick = onDismiss) {
                        Text("Try Again")
                    }
                }
            }
        }
    }
}
