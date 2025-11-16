package com.jc.photobooth.permissions

/**
 * Represents the state of a camera permission request.
 */
enum class PermissionState {
    /** Permission has been granted by the user */
    GRANTED,

    /** Permission was denied, but can be requested again */
    DENIED,

    /** Permission has not been requested yet */
    NOT_DETERMINED,

    /** Permission was permanently denied (user selected "Don't ask again") */
    PERMANENTLY_DENIED;

    /**
     * Returns true if the permission is granted.
     */
    val isGranted: Boolean
        get() = this == GRANTED

    /**
     * Returns true if we should show a rationale/explanation to the user.
     * This is typically true when permission is permanently denied and we need
     * to direct the user to settings.
     */
    val shouldShowRationale: Boolean
        get() = this == PERMANENTLY_DENIED
}
