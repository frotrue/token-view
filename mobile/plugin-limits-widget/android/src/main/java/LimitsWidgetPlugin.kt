package com.tokenview.widget

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class UpdateArgs {
    lateinit var json: String
}

@TauriPlugin
class LimitsWidgetPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun update(invoke: Invoke) {
        val state = try {
            WidgetStore.parse(invoke.parseArgs(UpdateArgs::class.java).json)
        } catch (_: Exception) { null }
        if (state == null) {
            invoke.reject("invalid_state")
            return
        }
        WidgetStore.update(activity, state)
        LimitsWidgetProvider.redraw(activity)
        LimitsRefreshWorker.syncSchedule(activity)
        invoke.resolve()
    }

    @Command
    fun clear(invoke: Invoke) {
        WidgetStore.clear(activity)
        LimitsRefreshWorker.cancel(activity)
        LimitsWidgetProvider.redraw(activity)
        invoke.resolve()
    }
}
