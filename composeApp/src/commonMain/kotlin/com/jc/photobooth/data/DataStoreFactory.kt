package com.jc.photobooth.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences

/**
 * Platform-specific DataStore creation
 */
expect fun createDataStore(): DataStore<Preferences>
