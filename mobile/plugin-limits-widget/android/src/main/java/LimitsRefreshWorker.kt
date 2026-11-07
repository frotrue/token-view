package com.tokenview.widget

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import org.json.JSONObject

class LimitsRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        try {
            refresh()
        } catch (_: Exception) {
            // Leave measured state intact; the next periodic run may succeed.
            // Never log tokens, response bodies, or account information.
        } finally {
            LimitsWidgetProvider.redraw(applicationContext)
        }
        return Result.success()
    }

    private fun refresh() {
        if (LimitsWidgetProvider.widgetIds(applicationContext).isEmpty()) {
            cancel(applicationContext)
            return
        }
        val target = WidgetStore.refreshTarget(applicationContext) ?: return
        if (target.state.provider != "google" || !hasInternet()) return
        val request = AuthorizationRequest.builder().setRequestedScopes(listOf(
            Scope("https://www.googleapis.com/auth/drive.appdata"),
            Scope("https://www.googleapis.com/auth/userinfo.email"),
        )).build()
        val authorization = Tasks.await(
            Identity.getAuthorizationClient(applicationContext).authorize(request), 30, TimeUnit.SECONDS)
        if (authorization.hasResolution()) return
        val token = authorization.accessToken?.takeIf { it.isNotBlank() } ?: return
        if (isStopped) return
        val fields = URLEncoder.encode("files(id,name,modifiedTime,appProperties)", "UTF-8")
        val files = JSONObject(String(get("$FILES?spaces=appDataFolder&pageSize=1000&fields=$fields", token), Charsets.UTF_8))
            .optJSONArray("files") ?: return
        var best: JSONObject? = null
        var latest = -1.0
        for (i in 0 until files.length()) {
            val file = files.optJSONObject(i) ?: continue
            val name = file.opt("name") as? String ?: continue
            val props = file.optJSONObject("appProperties") ?: continue
            if (!name.startsWith(PREFIX) || props.opt("tv") != "snapshot") continue
            val deviceId = (props.opt("deviceId") as? String)?.takeIf { it.isNotEmpty() } ?: name.removePrefix(PREFIX)
            if (deviceId != target.state.deviceId) continue
            val time = maxOf(propertyTime(props, "capturedAt"), propertyTime(props, "checkedAt"))
            if (time > latest) { latest = time; best = file }
        }
        val file = best ?: return
        if (propertyTime(file.getJSONObject("appProperties"), "capturedAt") <= target.state.capturedAt) return
        val id = file.opt("id") as? String ?: return
        if (id.isEmpty() || isStopped) return
        val bytes = get("$FILES/${URLEncoder.encode(id, "UTF-8")}?alt=media", token)
        val decoded = if (bytes.size >= 2 && bytes[0] == 0x1f.toByte() && bytes[1] == 0x8b.toByte()) {
            GZIPInputStream(ByteArrayInputStream(bytes)).use { readLimited(it) }
        } else bytes
        val state = SnapshotLimits.parse(JSONObject(String(decoded, Charsets.UTF_8)), target.state.deviceId) ?: return
        if (!isStopped && LimitsWidgetProvider.widgetIds(applicationContext).isNotEmpty()) {
            WidgetStore.saveRefreshed(applicationContext, target, state)
        }
    }

    private fun hasInternet(): Boolean {
        return try {
            val connectivity = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
            val network = connectivity.activeNetwork ?: return false
            connectivity.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        } catch (_: Exception) { false }
    }

    private fun propertyTime(props: JSONObject, key: String): Double =
        (props.opt(key) as? String)?.toDoubleOrNull()?.let { WidgetStore.number(it, WidgetStore.MAX_TIME) } ?: 0.0

    private fun get(url: String, token: String): ByteArray {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 20_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer $token")
            if (connection.responseCode !in 200..299) throw IllegalStateException("http_failed")
            if (connection.contentLengthLong > MAX_BYTES) throw IllegalStateException("too_large")
            return connection.inputStream.use { readLimited(it) }
        } finally {
            connection.disconnect()
        }
    }

    private fun readLimited(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            if (isStopped) throw IllegalStateException("stopped")
            val count = input.read(buffer)
            if (count < 0) break
            if (out.size() + count > MAX_BYTES) throw IllegalStateException("too_large")
            out.write(buffer, 0, count)
        }
        return out.toByteArray()
    }

    companion object {
        private const val NAME = "token-view-limits-widget"
        private const val FILES = "https://www.googleapis.com/drive/v3/files"
        private const val PREFIX = "tv-snapshot-"
        private const val MAX_BYTES = 8 * 1024 * 1024

        fun syncSchedule(context: Context) {
            if (WidgetStore.read(context) == null || LimitsWidgetProvider.widgetIds(context).isEmpty()) {
                cancel(context)
                return
            }
            // Redraw relative times and expired limits for both providers, even offline.
            val work = PeriodicWorkRequestBuilder<LimitsRefreshWorker>(15, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, work)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
