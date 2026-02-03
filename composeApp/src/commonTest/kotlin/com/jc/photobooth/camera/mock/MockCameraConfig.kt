package com.jc.photobooth.camera.mock

/**
 * Configuration for mock camera behavior.
 *
 * Allows customization of capture timing, image generation, and error injection
 * for testing different scenarios.
 */
data class MockCameraConfig(
    /** Simulated delay before photo capture completes (milliseconds) */
    val captureDelayMs: Long = 100,

    /** Width of generated test images */
    val imageWidth: Int = 640,

    /** Height of generated test images */
    val imageHeight: Int = 480,

    /** Style of generated images (solid colors or patterns) */
    val imageStyle: MockImageStyle = MockImageStyle.SOLID_COLOR,

    /** Whether to throw an error during capture (for testing error handling) */
    val shouldThrowError: Boolean = false,

    /** Error message to throw when shouldThrowError is true */
    val errorMessage: String = "Mock camera error"
)

/**
 * Visual style for generated mock images.
 */
enum class MockImageStyle {
    /** Solid color that rotates: Red → Green → Blue → Yellow */
    SOLID_COLOR,

    /** Checkerboard pattern with photo number overlay */
    PATTERN
}
