package com.tokenview.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal data class WidgetSlot(
    val source: String,
    val kind: String,
    val usedPct: Double,
    val resetsAt: Double,
    val ts: Double,
)

internal data class WidgetState(
    val provider: String,
    val deviceId: String,
    val capturedAt: Double,
    val claudeHooked: Boolean,
    val slots: List<WidgetSlot>,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("v", 1).put("provider", provider).put("deviceId", deviceId)
        .put("capturedAt", capturedAt).put("claudeHooked", claudeHooked)
        .put("slots", JSONArray().also { rows ->
            slots.forEach { slot ->
                rows.put(JSONObject().put("source", slot.source).put("kind", slot.kind)
                    .put("usedPct", slot.usedPct).put("resetsAt", slot.resetsAt).put("ts", slot.ts))
            }
        })
}

internal data class RefreshTarget(val state: WidgetState, val revision: Long)

internal object WidgetStore {
    private const val PREFS = "token_view_limits_widget"
    private const val KEY = "state"
    const val MAX_TIME = 8.64e15
    private var revision = 0L

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // Do not coerce JSON strings, booleans or nulls into numbers.
    fun number(value: Any?, max: Double = Double.MAX_VALUE): Double? {
        val n = (value as? Number)?.toDouble() ?: return null
        return n.takeIf { it.isFinite() && it >= 0 && it <= max }
    }

    fun parse(json: String): WidgetState? = try {
        parse(JSONObject(json))
    } catch (_: Exception) { null }

    fun parse(value: JSONObject): WidgetState? {
        if (number(value.opt("v")) != 1.0) return null
        val provider = value.opt("provider") as? String ?: return null
        if (provider != "google" && provider != "github") return null
        val deviceId = value.opt("deviceId") as? String ?: return null
        if (deviceId.length !in 1..128) return null
        val capturedAt = number(value.opt("capturedAt"), MAX_TIME) ?: return null
        val hooked = value.opt("claudeHooked") as? Boolean ?: return null
        val rows = value.optJSONArray("slots") ?: return null
        if (rows.length() > 4) return null
        val slots = mutableListOf<WidgetSlot>()
        val seen = mutableSetOf<Pair<String, String>>()
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: return null
            val source = row.opt("source") as? String ?: return null
            val kind = row.opt("kind") as? String ?: return null
            if (source != "claude" && source != "codex") return null
            if (kind != "5h" && kind != "week") return null
            if (!seen.add(source to kind)) return null
            slots.add(WidgetSlot(source, kind,
                number(row.opt("usedPct"), 1_000_000.0) ?: return null,
                number(row.opt("resetsAt"), MAX_TIME) ?: return null,
                number(row.opt("ts"), MAX_TIME) ?: return null))
        }
        return WidgetState(provider, deviceId, capturedAt, hooked, slots)
    }

    @Synchronized
    fun read(context: Context): WidgetState? = try {
        prefs(context).getString(KEY, null)?.let { parse(it) }
    } catch (_: Exception) { null }

    @Synchronized
    fun update(context: Context, state: WidgetState) {
        revision++
        val old = read(context)
        if (old?.deviceId == state.deviceId && state.capturedAt < old.capturedAt) return
        // Serialize the allowlisted model, never the caller's arbitrary JSON keys.
        prefs(context).edit().putString(KEY, state.toJson().toString()).apply()
    }

    @Synchronized
    fun refreshTarget(context: Context): RefreshTarget? = read(context)?.let { RefreshTarget(it, revision) }

    @Synchronized
    fun saveRefreshed(context: Context, target: RefreshTarget, state: WidgetState) {
        val current = read(context) ?: return
        // An in-flight read must not undo logout, an account switch or an app update.
        if (revision != target.revision || current != target.state) return
        if (current.provider != "google" || state.provider != "google" || current.deviceId != state.deviceId) return
        if (state.capturedAt <= current.capturedAt) return
        prefs(context).edit().putString(KEY, state.toJson().toString()).apply()
        revision++
    }

    @Synchronized
    fun clear(context: Context) {
        revision++
        prefs(context).edit().remove(KEY).apply()
    }
}
