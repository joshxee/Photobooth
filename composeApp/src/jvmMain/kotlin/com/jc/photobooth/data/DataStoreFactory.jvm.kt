package com.jc.photobooth.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import java.io.File

actual fun createDataStore(): DataStore<Preferences> {
    return androidx.datastore.preferences.core.PreferenceDataStoreFactory.create {
        File(System.getProperty("user.home") + "/.photobooth/photobooth_settings.preferences_pb")
    }
}
