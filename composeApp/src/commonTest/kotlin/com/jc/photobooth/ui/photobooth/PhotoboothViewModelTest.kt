package com.jc.photobooth.ui.photobooth

import com.jc.photobooth.camera.CameraController
import com.jc.photobooth.model.PhotoboothConfig
import com.jc.photobooth.model.PhotoData
import com.jc.photobooth.permissions.CameraPermissionHandler
import com.jc.photobooth.permissions.PermissionState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class PhotoboothViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var mockPermissionHandler: CameraPermissionHandler
    private lateinit var mockCameraController: CameraController
    private lateinit var viewModel: PhotoboothViewModel

    @BeforeTest
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        mockPermissionHandler = TestPermissionHandler()
        mockCameraController = TestCameraControllerForViewModel()
    }

    @AfterTest
    fun teardown() {
        Dispatchers.resetMain()
    }

    @Test
    fun initialStateHasNotDeterminedPermission() = runTest {
        viewModel = PhotoboothViewModel(
            mockPermissionHandler,
            mockCameraController
        )
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(PermissionState.NOT_DETERMINED, viewModel.uiState.value.permissionState)
    }

    @Test
    fun initialCaptureStateIsIdle() = runTest {
        viewModel = PhotoboothViewModel(
            mockPermissionHandler,
            mockCameraController
        )
        assertTrue(viewModel.uiState.value.captureState is CaptureState.Idle)
    }

    @Test
    fun checkPermissionUpdatesPermissionState() = runTest {
        val handler = object : CameraPermissionHandler {
            override fun checkPermission() = PermissionState.GRANTED
            override fun requestPermission() = PermissionState.GRANTED
            override fun openSettings() {}
        }
        viewModel = PhotoboothViewModel(handler, mockCameraController)
        viewModel.checkPermission()
        assertEquals(PermissionState.GRANTED, viewModel.uiState.value.permissionState)
    }

    @Test
    fun onPermissionRequestedUpdatesFlag() = runTest {
        viewModel = PhotoboothViewModel(mockPermissionHandler, mockCameraController)
        viewModel.onPermissionRequested()
        assertTrue(viewModel.uiState.value.isPermissionRequested)
    }

    @Test
    fun updatePermissionStateChangesPermissionState() = runTest {
        viewModel = PhotoboothViewModel(mockPermissionHandler, mockCameraController)
        viewModel.updatePermissionState(PermissionState.GRANTED)
        assertEquals(PermissionState.GRANTED, viewModel.uiState.value.permissionState)
    }

    @Test
    fun `startCaptureSequence goes through countdown states`() = runTest {
        val config = PhotoboothConfig(countdownSeconds = 2, numberOfPhotos = 1)
        viewModel = PhotoboothViewModel(
            mockPermissionHandler,
            mockCameraController,
            config
        )

        viewModel.startCaptureSequence()

        // Advance past first countdown tick
        testDispatcher.scheduler.advanceTimeBy(1000)
        var state = viewModel.uiState.value.captureState
        assertTrue(state is CaptureState.Countdown)
        assertEquals(2, (state as CaptureState.Countdown).remainingSeconds)

        // Advance past second countdown tick
        testDispatcher.scheduler.advanceTimeBy(1000)
        state = viewModel.uiState.value.captureState
        assertTrue(state is CaptureState.Countdown)
        assertEquals(1, (state as CaptureState.Countdown).remainingSeconds)

        // Advance past capture and completion
        testDispatcher.scheduler.advanceTimeBy(2000)
        state = viewModel.uiState.value.captureState
        assertTrue(state is CaptureState.Complete)
    }

    @Test
    fun startCaptureSequenceCapturesCorrectNumberOfPhotos() = runTest {
        val config = PhotoboothConfig(countdownSeconds = 1, numberOfPhotos = 3)
        viewModel = PhotoboothViewModel(
            mockPermissionHandler,
            mockCameraController,
            config
        )

        viewModel.startCaptureSequence()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value.captureState
        assertTrue(state is CaptureState.Complete)
        assertEquals(3, (state as CaptureState.Complete).photos.size)
    }

    @Test
    fun startCaptureSequenceHandlesErrors() = runTest {
        val errorController = object : CameraController {
            override fun startPreview() {}
            override fun stopPreview() {}
            override suspend fun capturePhoto(): PhotoData {
                throw Exception("Camera error")
            }
            override fun release() {}
        }

        viewModel = PhotoboothViewModel(
            mockPermissionHandler,
            errorController
        )

        viewModel.startCaptureSequence()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value.captureState
        assertTrue(state is CaptureState.Error)
        assertEquals("Camera error", (state as CaptureState.Error).message)
    }

    @Test
    fun resetCaptureReturnsToIdleState() = runTest {
        viewModel = PhotoboothViewModel(mockPermissionHandler, mockCameraController)
        viewModel.startCaptureSequence()
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.resetCapture()

        assertTrue(viewModel.uiState.value.captureState is CaptureState.Idle)
    }
}

/**
 * Test implementation of CameraPermissionHandler
 */
class TestPermissionHandler : CameraPermissionHandler {
    override fun checkPermission() = PermissionState.NOT_DETERMINED
    override fun requestPermission() = PermissionState.NOT_DETERMINED
    override fun openSettings() {}
}

/**
 * Test implementation of CameraController for ViewModel tests
 */
class TestCameraControllerForViewModel : CameraController {
    override fun startPreview() {}
    override fun stopPreview() {}
    override suspend fun capturePhoto() = PhotoData(byteArrayOf(1, 2, 3), System.currentTimeMillis())
    override fun release() {}
}
