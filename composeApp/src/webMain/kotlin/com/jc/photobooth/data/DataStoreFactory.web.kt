package com.jc.photobooth.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences

actual fun createDataStore(): DataStore<Preferences> {
    return androidx.datastore.preferences.core.PreferenceDataStoreFactory.create {
        // Web stores in browser's localStorage/IndexedDB
        "photobooth_settings.preferences_pb"
    }
}
