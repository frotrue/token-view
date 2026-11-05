package com.tokenview.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import kotlin.math.ceil
import kotlin.math.roundToInt

class LimitsWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        redraw(context)
        LimitsRefreshWorker.syncSchedule(context)
    }

    override fun onEnabled(context: Context) {
        LimitsRefreshWorker.syncSchedule(context)
    }

    override fun onDisabled(context: Context) {
        LimitsRefreshWorker.cancel(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        redraw(context)
    }

    companion object {
        fun widgetIds(context: Context): IntArray = AppWidgetManager.getInstance(context)
            .getAppWidgetIds(ComponentName(context, LimitsWidgetProvider::class.java))

        fun redraw(context: Context) {
            val ids = widgetIds(context)
            if (ids.isEmpty()) return
            val views = RemoteViews(context.packageName, R.layout.widget_limits)
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (launch != null) {
                views.setOnClickPendingIntent(android.R.id.background, PendingIntent.getActivity(context, 0, launch,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            }
            views.setContentDescription(android.R.id.background, context.getString(R.string.widget_accessibility))
            val state = WidgetStore.read(context)
            views.setViewVisibility(R.id.widget_columns, if (state == null) View.GONE else View.VISIBLE)
            views.setViewVisibility(R.id.widget_empty, if (state == null) View.VISIBLE else View.GONE)
            if (state != null) {
                val now = System.currentTimeMillis().toDouble()
                renderColumn(context, views, state, "claude", R.id.claude_age, now)
                renderColumn(context, views, state, "codex", R.id.codex_age, now)
                renderSlot(context, views, state, "claude", "5h", now,
                    R.id.claude_5h, R.id.claude_5h_value, R.id.claude_5h_progress, R.id.claude_5h_reset)
                renderSlot(context, views, state, "claude", "week", now,
                    R.id.claude_week, R.id.claude_week_value, R.id.claude_week_progress, R.id.claude_week_reset)
                renderSlot(context, views, state, "codex", "5h", now,
                    R.id.codex_5h, R.id.codex_5h_value, R.id.codex_5h_progress, R.id.codex_5h_reset)
                renderSlot(context, views, state, "codex", "week", now,
                    R.id.codex_week, R.id.codex_week_value, R.id.codex_week_progress, R.id.codex_week_reset)
            }
            AppWidgetManager.getInstance(context).updateAppWidget(ids, views)
        }

        private fun renderColumn(context: Context, views: RemoteViews, state: WidgetState, source: String, ageId: Int, now: Double) {
            val ts = state.slots.filter { it.source == source }.maxOfOrNull { it.ts }
            views.setTextViewText(ageId, if (ts == null) "" else ageText(context, now - ts))
            views.setTextColor(ageId, ContextCompat.getColor(context,
                if (ts != null && now - ts >= 3 * 3_600_000) R.color.widget_serious else R.color.widget_muted))
        }

        private fun renderSlot(context: Context, views: RemoteViews, state: WidgetState, source: String, kind: String,
            now: Double, containerId: Int, valueId: Int, progressId: Int, resetId: Int) {
            val slot = state.slots.find { it.source == source && it.kind == kind }
            val missing = when {
                slot == null -> if (source == "claude" && !state.claudeHooked) R.string.widget_no_hook else R.string.widget_no_record
                slot.resetsAt > 0 && slot.resetsAt <= now -> R.string.widget_reset_passed
                else -> null
            }
            val name = if (source == "claude") "Claude" else "Codex"
            val label = context.getString(if (kind == "5h") R.string.widget_window_5h else R.string.widget_window_week)
            if (missing != null || slot == null) {
                val reason = context.getString(missing ?: R.string.widget_no_record)
                views.setTextViewText(valueId, context.getString(R.string.widget_missing))
                views.setViewVisibility(progressId, View.INVISIBLE)
                views.setTextViewText(resetId, reason)
                views.setContentDescription(containerId, "$name $label $reason")
                return
            }
            val used = slot.usedPct.roundToInt()
            val reset = if (slot.resetsAt == 0.0) context.getString(R.string.widget_reset_unknown)
                else resetText(context, slot.resetsAt - now)
            views.setTextViewText(valueId, "$used%")
            views.setViewVisibility(progressId, View.VISIBLE)
            views.setProgressBar(progressId, 100, minOf(100, used), false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val color = when {
                    slot.usedPct >= 90 -> R.color.widget_critical
                    slot.usedPct >= 70 -> R.color.widget_warning
                    source == "claude" -> R.color.widget_claude
                    else -> R.color.widget_codex
                }
                views.setColorStateList(progressId, "setProgressTintList", ColorStateList.valueOf(ContextCompat.getColor(context, color)))
            }
            views.setTextViewText(resetId, reset)
            views.setContentDescription(containerId, context.getString(R.string.widget_slot_accessibility,
                name, label, used, reset, ageText(context, now - slot.ts)))
        }

        private fun resetText(context: Context, remaining: Double): String {
            if (remaining < 60_000) return context.getString(R.string.widget_reset_soon)
            if (remaining < 3_600_000) return context.getString(R.string.widget_reset_minutes, maxOf(1, ceil(remaining / 60_000).toLong()))
            val minutes = (remaining / 60_000).toLong()
            val hours = minutes / 60
            if (remaining < 86_400_000) return if (minutes % 60 == 0L) context.getString(R.string.widget_reset_hours, hours)
                else context.getString(R.string.widget_reset_hours_minutes, hours, minutes % 60)
            return if (hours % 24 == 0L) context.getString(R.string.widget_reset_days, hours / 24)
                else context.getString(R.string.widget_reset_days_hours, hours / 24, hours % 24)
        }

        private fun ageText(context: Context, elapsed: Double): String {
            val age = maxOf(0.0, elapsed)
            return when {
                age < 60_000 -> context.getString(R.string.widget_age_now)
                age < 3_600_000 -> context.getString(R.string.widget_age_minutes, (age / 60_000).toLong())
                age < 86_400_000 -> context.getString(R.string.widget_age_hours, (age / 3_600_000).toLong())
                else -> context.getString(R.string.widget_age_days, (age / 86_400_000).toLong())
            }
        }
    }
}
