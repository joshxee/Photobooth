package com.jc.photobooth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ComposeAppCommonTest {

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
    fun testScreenEnumHasSonyMark2Screen() {
        val screen = Screen.PHOTOBOOTH_SONY_MARK2
        assertNotNull(screen)
        assertEquals("PHOTOBOOTH_SONY_MARK2", screen.name)
    }

    @Test
    fun testScreenEnumHasSettingsScreen() {
        val screen = Screen.SETTINGS
        assertNotNull(screen)
        assertEquals("SETTINGS", screen.name)
    }

    @Test
    fun testScreenEnumHasSevenValues() {
        val screens = Screen.entries
        assertEquals(7, screens.size)
    }

    @Test
    fun testScreenEnumOrder() {
        val screens = Screen.entries
        assertEquals(Screen.CAMERA_SELECTION, screens[0])
        assertEquals(Screen.PHOTOBOOTH_NATIVE, screens[1])
        assertEquals(Screen.PHOTOBOOTH_SONY_MARK2, screens[2])
        assertEquals(Screen.PHOTOBOOTH_MOCK, screens[3])
        assertEquals(Screen.SETTINGS, screens[4])
        assertEquals(Screen.SONY_API_DISCOVERY, screens[5])
        assertEquals(Screen.UNDER_CONSTRUCTION, screens[6])
    }
}
