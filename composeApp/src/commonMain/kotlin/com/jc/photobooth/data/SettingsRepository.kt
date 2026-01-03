package com.jc.photobooth.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
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
}
