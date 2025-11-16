package com.jc.photobooth.ui.photostrip

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.model.toImageBitmap

@Composable
fun PhotoStripScreen(
    photos: List<PhotoData>,
    onReturnToPhotobooth: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "Your Photo Strip",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Photo strip layout
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            photos.forEach { photo ->
                PhotoItem(
                    photoData = photo,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                )
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onReturnToPhotobooth,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Take Another Photo Strip")
        }
    }
}

@Composable
fun PhotoItem(photoData: PhotoData, modifier: Modifier = Modifier) {
    val imageBitmap = remember(photoData) {
        photoData.toImageBitmap()
    }

    Image(
        bitmap = imageBitmap,
        contentDescription = "Photo",
        modifier = modifier,
        contentScale = ContentScale.Crop
    )
}
