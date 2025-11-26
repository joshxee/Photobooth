package com.jc.photobooth.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "photobooth_settings")

private lateinit var applicationContext: Context

fun initDataStore(context: Context) {
    applicationContext = context.applicationContext
}

actual fun createDataStore(): DataStore<Preferences> {
    return applicationContext.dataStore
}
