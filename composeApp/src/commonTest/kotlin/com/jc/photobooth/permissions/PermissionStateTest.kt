package com.jc.photobooth.permissions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PermissionStateTest {

    @Test
    fun testPermissionStateValues() {
        // Verify all expected states exist
        assertEquals("GRANTED", PermissionState.GRANTED.name)
        assertEquals("DENIED", PermissionState.DENIED.name)
        assertEquals("NOT_DETERMINED", PermissionState.NOT_DETERMINED.name)
        assertEquals("PERMANENTLY_DENIED", PermissionState.PERMANENTLY_DENIED.name)
    }

    @Test
    fun testIsGrantedForGrantedState() {
        assertTrue(PermissionState.GRANTED.isGranted)
    }

    @Test
    fun testIsGrantedForDeniedState() {
        assertFalse(PermissionState.DENIED.isGranted)
    }

    @Test
    fun testIsGrantedForNotDeterminedState() {
        assertFalse(PermissionState.NOT_DETERMINED.isGranted)
    }

    @Test
    fun testIsGrantedForPermanentlyDeniedState() {
        assertFalse(PermissionState.PERMANENTLY_DENIED.isGranted)
    }

    @Test
    fun testShouldShowRationaleForGrantedState() {
        assertFalse(PermissionState.GRANTED.shouldShowRationale)
    }

    @Test
    fun testShouldShowRationaleForDeniedState() {
        assertFalse(PermissionState.DENIED.shouldShowRationale)
    }

    @Test
    fun testShouldShowRationaleForNotDeterminedState() {
        assertFalse(PermissionState.NOT_DETERMINED.shouldShowRationale)
    }

    @Test
    fun testShouldShowRationaleForPermanentlyDeniedState() {
        assertTrue(PermissionState.PERMANENTLY_DENIED.shouldShowRationale)
    }

    @Test
    fun testEnumCount() {
        assertEquals(4, PermissionState.values().size)
    }
}
