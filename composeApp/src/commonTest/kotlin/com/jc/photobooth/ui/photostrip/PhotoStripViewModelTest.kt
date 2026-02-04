package com.jc.photobooth.ui.photostrip

import com.jc.photobooth.model.PhotoData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class PhotoStripViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var viewModel: PhotoStripViewModel

    @BeforeTest
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        viewModel = PhotoStripViewModel(countdownDurationSeconds = 10)
    }

    @AfterTest
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun initialState_hasCorrectValues() {
        val state = viewModel.uiState.value

        assertEquals(10, state.countdownSeconds)
        assertEquals(10, state.countdownRemaining)
        assertTrue(state.isCountdownActive)
    }

    @Test
    fun startCountdown_decreasesRemainingTime() = runTest(testDispatcher) {
        viewModel.startCountdown()
        runCurrent() // Execute the launch

        // Advance by 1 second
        advanceTimeBy(1000)
        runCurrent() // Process the delay completion

        assertEquals(9, viewModel.uiState.value.countdownRemaining)
        assertTrue(viewModel.uiState.value.isCountdownActive)
    }

    @Test
    fun startCountdown_triggersCallbackWhenComplete() = runTest(testDispatcher) {
        var callbackInvoked = false
        viewModel.onCountdownComplete = { callbackInvoked = true }

        viewModel.startCountdown()

        // Advance by full duration (10 seconds)
        advanceTimeBy(10_000)
        advanceUntilIdle()

        assertTrue(callbackInvoked)
        assertEquals(0, viewModel.uiState.value.countdownRemaining)
        assertFalse(viewModel.uiState.value.isCountdownActive)
    }

    @Test
    fun pauseCountdown_stopsTimer() = runTest(testDispatcher) {
        viewModel.startCountdown()
        runCurrent() // Execute the launch

        // Advance by 3 seconds
        advanceTimeBy(3000)
        runCurrent() // Process delay completions
        assertEquals(7, viewModel.uiState.value.countdownRemaining)

        // Pause countdown
        viewModel.pauseCountdown()
        assertFalse(viewModel.uiState.value.isCountdownActive)

        // Advance time - should not decrease
        advanceTimeBy(2000)
        runCurrent()
        assertEquals(7, viewModel.uiState.value.countdownRemaining)
    }

    @Test
    fun resumeCountdown_continuesFromPausedTime() = runTest(testDispatcher) {
        viewModel.startCountdown()
        runCurrent() // Execute the launch

        // Advance by 3 seconds
        advanceTimeBy(3000)
        runCurrent() // Process delay completions
        assertEquals(7, viewModel.uiState.value.countdownRemaining)

        // Pause
        viewModel.pauseCountdown()

        // Resume
        viewModel.resumeCountdown()
        runCurrent() // Execute the resume launch
        assertTrue(viewModel.uiState.value.isCountdownActive)

        // Advance by 2 more seconds
        advanceTimeBy(2000)
        runCurrent() // Process delay completions
        assertEquals(5, viewModel.uiState.value.countdownRemaining)
    }

    @Test
    fun resetCountdown_resetsToInitialState() = runTest(testDispatcher) {
        viewModel.startCountdown()
        runCurrent() // Execute the launch

        // Advance by 5 seconds
        advanceTimeBy(5000)
        runCurrent() // Process delay completions
        assertEquals(5, viewModel.uiState.value.countdownRemaining)

        // Reset
        viewModel.resetCountdown()

        assertEquals(10, viewModel.uiState.value.countdownRemaining)
        assertFalse(viewModel.uiState.value.isCountdownActive)
    }

    @Test
    fun customDuration_usesProvidedValue() {
        val customViewModel = PhotoStripViewModel(countdownDurationSeconds = 15)

        assertEquals(15, customViewModel.uiState.value.countdownSeconds)
        assertEquals(15, customViewModel.uiState.value.countdownRemaining)
    }

    @Test
    fun skipCountdown_immediatelyTriggersCallback() = runTest(testDispatcher) {
        var callbackInvoked = false
        viewModel.onCountdownComplete = { callbackInvoked = true }

        viewModel.skipCountdown()
        advanceUntilIdle()

        assertTrue(callbackInvoked)
        assertEquals(0, viewModel.uiState.value.countdownRemaining)
        assertFalse(viewModel.uiState.value.isCountdownActive)
    }

    @Test
    fun setPhotos_updatesPhotoList() {
        val testPhotos = listOf(
            PhotoData(byteArrayOf(1, 2, 3), timestamp = 1000L),
            PhotoData(byteArrayOf(4, 5, 6), timestamp = 2000L)
        )

        viewModel.setPhotos(testPhotos)

        assertEquals(2, viewModel.uiState.value.photos.size)
        assertEquals(testPhotos, viewModel.uiState.value.photos)
    }

    @Test
    fun clearPhotos_removesAllPhotos() {
        val testPhotos = listOf(
            PhotoData(byteArrayOf(1, 2, 3), timestamp = 1000L),
            PhotoData(byteArrayOf(4, 5, 6), timestamp = 2000L)
        )

        viewModel.setPhotos(testPhotos)
        assertEquals(2, viewModel.uiState.value.photos.size)

        viewModel.clearPhotos()

        assertTrue(viewModel.uiState.value.photos.isEmpty())
    }

    @Test
    fun clearPhotos_preventsMemoryLeak() {
        // Set photos
        val largePhotoData = ByteArray(1024 * 100) // 100KB photo
        val testPhotos = List(10) { PhotoData(largePhotoData, timestamp = 1000L + it) }

        viewModel.setPhotos(testPhotos)
        assertEquals(10, viewModel.uiState.value.photos.size)

        // Clear photos - should remove all references
        viewModel.clearPhotos()

        assertTrue(viewModel.uiState.value.photos.isEmpty())
        // Photos should be garbage collected after this point
    }
}
