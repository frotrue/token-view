package com.tokenview.apkupdate

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

@InvokeArg
class InstallArgs {
    var url: String = ""
}

/** Serves the downloaded APK to the system installer. */
class ApkFileProvider : FileProvider()

/**
 * Downloads a Token View release APK and opens the system installer. The first
 * time, Android asks the user to allow installs from this app. The installer only
 * accepts the file as an update when it carries the installed app's signature.
 */
@TauriPlugin
class ApkUpdatePlugin(private val activity: Activity) : Plugin(activity) {
    private companion object {
        const val RELEASES = "https://github.com/frotrue/token-view/releases/download/"
        const val MAX_BYTES = 200L * 1024 * 1024
    }

    @Command
    fun install(invoke: Invoke) {
        val url = invoke.parseArgs(InstallArgs::class.java).url
        if (!url.startsWith(RELEASES) || !url.endsWith(".apk")) {
            invoke.reject("untrusted_url")
            return
        }
        thread(name = "apk-update") {
            try {
                val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val apk = File(dir, "token-view.apk")
                download(url, apk)
                @Suppress("DEPRECATION")
                val info = activity.packageManager.getPackageArchiveInfo(apk.path, 0)
                if (info?.packageName != activity.packageName) {
                    apk.delete()
                    invoke.reject("wrong_package")
                    return@thread
                }
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.apkupdate", apk)
                val intent = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.runOnUiThread {
                    try {
                        activity.startActivity(intent)
                        invoke.resolve(JSObject())
                    } catch (e: Exception) {
                        invoke.reject(e.message ?: "install_failed")
                    }
                }
            } catch (e: Exception) {
                invoke.reject(e.message ?: "download_failed")
            }
        }
    }

    // Follows GitHub's redirect to its asset host (https to https).
    private fun download(url: String, out: File) {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = true
            if (conn.responseCode != HttpURLConnection.HTTP_OK) throw IOException("HTTP ${conn.responseCode}")
            if (conn.contentLengthLong > MAX_BYTES) throw IOException("too_large")
            conn.inputStream.use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) throw IOException("too_large")
                        output.write(buf, 0, n)
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }
}
