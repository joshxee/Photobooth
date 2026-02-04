package com.jc.photobooth.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import com.jc.photobooth.model.PhotoboothConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Repository for managing photobooth settings persistence.
 * Uses DataStore to save and retrieve PhotoboothConfig settings.
 */
class SettingsRepository(private val dataStore: DataStore<Preferences>) {

    companion object {
        private val NUMBER_OF_PHOTOS_KEY = intPreferencesKey("number_of_photos")
        private val COUNTDOWN_SECONDS_KEY = intPreferencesKey("countdown_seconds")
        private val KIOSK_MODE_ENABLED_KEY = booleanPreferencesKey("kiosk_mode_enabled")
        private val PHOTOSTRIP_COUNTDOWN_SECONDS_KEY = intPreferencesKey("photostrip_countdown_seconds")
    }

    /**
     * Get the current configuration as a Flow.
     * Returns default PhotoboothConfig if no settings are saved.
     */
    fun getConfig(): Flow<PhotoboothConfig> {
        return dataStore.data.map { preferences ->
            val numberOfPhotos = preferences[NUMBER_OF_PHOTOS_KEY] ?: 3
            val countdownSeconds = preferences[COUNTDOWN_SECONDS_KEY] ?: 3
            PhotoboothConfig(
                numberOfPhotos = numberOfPhotos,
                countdownSeconds = countdownSeconds
            )
        }
    }

    /**
     * Save the configuration to DataStore.
     */
    suspend fun saveConfig(config: PhotoboothConfig) {
        dataStore.edit { preferences ->
            preferences[NUMBER_OF_PHOTOS_KEY] = config.numberOfPhotos
            preferences[COUNTDOWN_SECONDS_KEY] = config.countdownSeconds
        }
    }

    /**
     * Get kiosk mode enabled state as a Flow.
     * Returns false by default (kiosk mode disabled).
     */
    fun getKioskModeEnabled(): Flow<Boolean> {
        return dataStore.data.map { preferences ->
            preferences[KIOSK_MODE_ENABLED_KEY] ?: false
        }
    }

    /**
     * Set kiosk mode enabled state.
     */
    suspend fun setKioskModeEnabled(enabled: Boolean) {
        dataStore.edit { preferences ->
            preferences[KIOSK_MODE_ENABLED_KEY] = enabled
        }
    }

    /**
     * Get photostrip countdown duration in seconds as a Flow.
     * Returns 10 seconds by default.
     */
    fun getPhotoStripCountdownSeconds(): Flow<Int> {
        return dataStore.data.map { preferences ->
            preferences[PHOTOSTRIP_COUNTDOWN_SECONDS_KEY] ?: 10
        }
    }

    /**
     * Set photostrip countdown duration in seconds.
     */
    suspend fun setPhotoStripCountdownSeconds(seconds: Int) {
        dataStore.edit { preferences ->
            preferences[PHOTOSTRIP_COUNTDOWN_SECONDS_KEY] = seconds
        }
    }
}
