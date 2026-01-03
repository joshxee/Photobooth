package com.jc.photobooth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ComposeAppCommonTest {

    @Test
    fun testScreenEnumHasWelcomeScreen() {
        val screen = Screen.WELCOME
        assertNotNull(screen)
        assertEquals("WELCOME", screen.name)
    }

    @Test
    fun testScreenEnumHasUnderConstructionScreen() {
        val screen = Screen.UNDER_CONSTRUCTION
        assertNotNull(screen)
        assertEquals("UNDER_CONSTRUCTION", screen.name)
    }

    @Test
    fun testScreenEnumHasCameraSelectionScreen() {
        val screen = Screen.CAMERA_SELECTION
        assertNotNull(screen)
        assertEquals("CAMERA_SELECTION", screen.name)
    }

    @Test
    fun testScreenEnumHasPhotoboothNativeScreen() {
        val screen = Screen.PHOTOBOOTH_NATIVE
        assertNotNull(screen)
        assertEquals("PHOTOBOOTH_NATIVE", screen.name)
    }

    @Test
    fun testScreenEnumHasPhotoboothSonyScreen() {
        val screen = Screen.PHOTOBOOTH_SONY
        assertNotNull(screen)
        assertEquals("PHOTOBOOTH_SONY", screen.name)
    }

    @Test
    fun testScreenEnumHasPhotoStripScreen() {
        val screen = Screen.PHOTO_STRIP
        assertNotNull(screen)
        assertEquals("PHOTO_STRIP", screen.name)
    }

    @Test
    fun testScreenEnumHasSettingsScreen() {
        val screen = Screen.SETTINGS
        assertNotNull(screen)
        assertEquals("SETTINGS", screen.name)
    }

    @Test
    fun testScreenEnumHasSevenValues() {
        val screens = Screen.values()
        assertEquals(7, screens.size)
    }

    @Test
    fun testScreenEnumOrder() {
        val screens = Screen.values()
        assertEquals(Screen.WELCOME, screens[0])
        assertEquals(Screen.CAMERA_SELECTION, screens[1])
        assertEquals(Screen.PHOTOBOOTH_NATIVE, screens[2])
        assertEquals(Screen.PHOTOBOOTH_SONY, screens[3])
        assertEquals(Screen.PHOTO_STRIP, screens[4])
        assertEquals(Screen.SETTINGS, screens[5])
        assertEquals(Screen.UNDER_CONSTRUCTION, screens[6])
    }
}