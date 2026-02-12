package com.jc.photobooth.gesture

/**
 * Creates a platform-specific GestureDetector, or null if not supported.
 *
 * On Android: returns a MediaPipe-based gesture detector.
 * On other platforms: returns null (gesture detection not available).
 */
expect fun createGestureDetector(): GestureDetector?
