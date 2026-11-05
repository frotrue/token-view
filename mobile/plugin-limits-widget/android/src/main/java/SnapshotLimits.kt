package com.tokenview.widget

import org.json.JSONObject

internal object SnapshotLimits {
    // Keep these selection rules identical to src/cloud/widget.ts.
    fun parse(snapshot: JSONObject, deviceId: String): WidgetState? {
        if (WidgetStore.number(snapshot.opt("schemaVersion")) != 1.0) return null
        if (snapshot.optJSONObject("device")?.opt("id") != deviceId) return null
        val capturedAt = WidgetStore.number(snapshot.opt("capturedAt"), WidgetStore.MAX_TIME) ?: return null
        val hooked = snapshot.opt("claudeHooked") as? Boolean ?: return null
        val limits = snapshot.optJSONObject("dashboard")?.optJSONArray("limits") ?: return null
        val rows = (0 until limits.length()).mapNotNull { limits.optJSONObject(it) }
        val slots = mutableListOf<WidgetSlot>()
        for (source in listOf("claude", "codex")) {
            val matching = rows.filter { it.opt("source") == source }
            val primary = matching.filter { it.opt("limitId") == source }
            val selected = mutableMapOf<String, WidgetSlot>()
            for (row in primary.ifEmpty { matching }) {
                val usedPct = WidgetStore.number(row.opt("usedPct")) ?: continue
                val resetsAt = WidgetStore.number(row.opt("resetsAt")) ?: continue
                val ts = WidgetStore.number(row.opt("ts")) ?: continue
                val minutes = WidgetStore.number(row.opt("windowMinutes")) ?: continue
                val win = row.opt("win")
                val kind = if (source == "claude") {
                    when (win) {
                        "five_hour" -> "5h"
                        "seven_day" -> "week"
                        else -> null
                    }
                } else {
                    when {
                        minutes == 300.0 || (minutes == 0.0 && win == "primary") -> "5h"
                        minutes == 10080.0 || (minutes == 0.0 && win == "secondary") -> "week"
                        else -> null
                    }
                } ?: continue
                val previous = selected[kind]
                if (previous == null || ts >= previous.ts) selected[kind] = WidgetSlot(source, kind, usedPct, resetsAt, ts)
            }
            for (kind in listOf("5h", "week")) selected[kind]?.let { slots.add(it) }
        }
        // Apply the same storage bounds as app-originated state before saving.
        return WidgetStore.parse(WidgetState("google", deviceId, capturedAt, hooked, slots).toJson())
    }
}
