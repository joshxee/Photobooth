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
    fun testScreenEnumHasTwoValues() {
        val screens = Screen.values()
        assertEquals(2, screens.size)
    }

    @Test
    fun testScreenEnumOrder() {
        val screens = Screen.values()
        assertEquals(Screen.WELCOME, screens[0])
        assertEquals(Screen.UNDER_CONSTRUCTION, screens[1])
    }
}