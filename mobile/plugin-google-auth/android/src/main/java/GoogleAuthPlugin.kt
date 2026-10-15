package com.tokenview.googleauth

import android.app.Activity
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope

@InvokeArg
class AuthorizeArgs {
    var interactive: Boolean = false
}

/**
 * Access tokens for the app's Drive appDataFolder via Google Play services. Google
 * matches this app to the project's "Android" OAuth client by package name and
 * signing-certificate SHA-1, so no client id is needed here.
 */
@TauriPlugin
class GoogleAuthPlugin(private val activity: Activity) : Plugin(activity) {
    private val scopes = listOf(
        Scope("https://www.googleapis.com/auth/drive.appdata"),
        Scope("https://www.googleapis.com/auth/userinfo.email"),
    )
    private var pending: Invoke? = null

    // The lifecycle-free register() may be called after the activity started.
    private val consent = (activity as ComponentActivity).activityResultRegistry.register(
        "token-view-google-consent",
        ActivityResultContracts.StartIntentSenderForResult(),
    ) { result -> onConsent(result) }

    @Command
    fun authorize(invoke: Invoke) {
        val args = invoke.parseArgs(AuthorizeArgs::class.java)
        val request = AuthorizationRequest.builder().setRequestedScopes(scopes).build()
        Identity.getAuthorizationClient(activity).authorize(request)
            .addOnSuccessListener { result ->
                if (!result.hasResolution()) {
                    resolve(invoke, result)
                    return@addOnSuccessListener
                }
                val sender = result.pendingIntent?.intentSender
                if (!args.interactive || sender == null) {
                    invoke.reject("consent_required")
                    return@addOnSuccessListener
                }
                pending?.reject("superseded")
                pending = invoke
                consent.launch(IntentSenderRequest.Builder(sender).build())
            }
            .addOnFailureListener { e -> invoke.reject(e.message ?: "authorization_failed") }
    }

    private fun onConsent(result: ActivityResult) {
        val invoke = pending ?: return
        pending = null
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.reject("cancelled")
            return
        }
        try {
            resolve(invoke, Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(result.data))
        } catch (e: Exception) {
            invoke.reject(e.message ?: "authorization_failed")
        }
    }

    private fun resolve(invoke: Invoke, result: AuthorizationResult) {
        val token = result.accessToken
        if (token == null) {
            invoke.reject("no_token")
            return
        }
        val out = JSObject()
        out.put("accessToken", token)
        out.put("scopes", result.grantedScopes.joinToString(" "))
        invoke.resolve(out)
    }
}
