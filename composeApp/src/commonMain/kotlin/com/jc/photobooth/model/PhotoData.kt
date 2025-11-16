package com.jc.photobooth.model

/**
 * Represents captured photo data from the photobooth.
 *
 * @property imageBytes The raw image data as a byte array
 * @property timestamp The time when the photo was captured (milliseconds since epoch)
 */
data class PhotoData(
    val imageBytes: ByteArray,
    val timestamp: Long
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other == null || this::class != other::class) return false

        other as PhotoData

        if (!imageBytes.contentEquals(other.imageBytes)) return false
        if (timestamp != other.timestamp) return false

        return true
    }

    override fun hashCode(): Int {
        var result = imageBytes.contentHashCode()
        result = 31 * result + timestamp.hashCode()
        return result
    }
}
