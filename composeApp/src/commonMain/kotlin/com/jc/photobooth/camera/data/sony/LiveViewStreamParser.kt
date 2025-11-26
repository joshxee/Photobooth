package com.jc.photobooth.camera.data.sony

import io.ktor.utils.io.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/**
 * Parser for Sony's live view stream format.
 *
 * Sony's live view stream is similar to MJPEG but uses a custom packet format:
 * - Common Header (8 bytes)
 *   - Byte 0: Start marker 1 (0xFF)
 *   - Byte 1: Start marker 2 / Payload type (0x01 = image, 0x02 = frame info)
 *   - Bytes 2-3: Sequence number (big-endian)
 *   - Bytes 4-7: Timestamp (big-endian)
 * - Payload Header (128 bytes)
 *   - Bytes 4-7: JPEG data size (3-byte big-endian at offset 4)
 *   - Rest: Padding/metadata
 * - JPEG Data (N bytes)
 */
class LiveViewStreamParser {
    companion object {
        private const val COMMON_HEADER_SIZE = 8
        private const val PAYLOAD_HEADER_SIZE = 128
        private const val START_BYTE = 0xFF.toByte()
        private const val PAYLOAD_TYPE_IMAGE = 0x01.toByte()
        private const val PAYLOAD_TYPE_FRAME_INFO = 0x02.toByte()
    }

    /**
     * Parse live view stream and emit JPEG frames as they arrive
     */
    fun parseFrames(channel: ByteReadChannel): Flow<ByteArray> = flow {
        try {
            while (!channel.isClosedForRead) {
                // Read common header (8 bytes)
                val commonHeader = ByteArray(COMMON_HEADER_SIZE)
                channel.readFully(commonHeader, 0, COMMON_HEADER_SIZE)

                // Validate start marker
                if (commonHeader[0] != START_BYTE) {
                    // Try to resync by finding next start marker
                    continue
                }

                val payloadType = commonHeader[1]

                // Read payload header (128 bytes)
                val payloadHeader = ByteArray(PAYLOAD_HEADER_SIZE)
                channel.readFully(payloadHeader, 0, PAYLOAD_HEADER_SIZE)

                // Extract JPEG size from payload header (bytes 4-6, 3-byte big-endian)
                val jpegSize = ((payloadHeader[4].toInt() and 0xFF) shl 16) or
                        ((payloadHeader[5].toInt() and 0xFF) shl 8) or
                        (payloadHeader[6].toInt() and 0xFF)

                if (jpegSize <= 0 || jpegSize > 10 * 1024 * 1024) { // Sanity check: max 10MB
                    continue
                }

                // Read JPEG data
                val jpegData = ByteArray(jpegSize)
                channel.readFully(jpegData, 0, jpegSize)

                // Only emit image payloads, skip frame info
                if (payloadType == PAYLOAD_TYPE_IMAGE) {
                    emit(jpegData)
                }

                // Optional: Read and discard padding to align to next packet
                val paddingSize = calculatePadding(jpegSize)
                if (paddingSize > 0) {
                    channel.discard(paddingSize.toLong())
                }
            }
        } catch (e: Exception) {
            // Stream ended or error occurred
            // This is expected when live view is stopped
        }
    }

    /**
     * Calculate padding bytes to align to next packet boundary
     * Sony cameras may pad to align packets
     */
    private fun calculatePadding(dataSize: Int): Int {
        val alignment = 4 // Common alignment value
        val remainder = dataSize % alignment
        return if (remainder == 0) 0 else alignment - remainder
    }
}

/**
 * Represents a parsed live view frame
 */
data class LiveViewFrame(
    val jpegData: ByteArray,
    val sequenceNumber: Int,
    val timestamp: Long
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other == null || this::class != other::class) return false

        other as LiveViewFrame

        if (!jpegData.contentEquals(other.jpegData)) return false
        if (sequenceNumber != other.sequenceNumber) return false
        if (timestamp != other.timestamp) return false

        return true
    }

    override fun hashCode(): Int {
        var result = jpegData.contentHashCode()
        result = 31 * result + sequenceNumber
        result = 31 * result + timestamp.hashCode()
        return result
    }
}
