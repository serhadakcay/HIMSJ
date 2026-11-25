package com.nexuschat.e2ee

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    companion object {
        // Sadece bu adresteki sayfa kamera/mikrofon ve rehber köprüsünü kullanabilir
        private const val APP_HOST = "sermsj.onrender.com"
        private const val APP_URL = "https://$APP_HOST"
        private const val STARTUP_PERMS_REQ = 1001
        private const val MEDIA_PERMS_REQ = 1002
    }

    private lateinit var webView: WebView
    private var pendingWebRequest: PermissionRequest? = null
    private var pendingWebResources: Array<String> = emptyArray()

    private fun isTrusted(uri: Uri?): Boolean =
        uri != null && uri.scheme == "https" && uri.host == APP_HOST

    private fun hasPerm(p: String): Boolean =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestStartupPermissions()

        webView = WebView(this)
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false

        webView.addJavascriptInterface(NativeContactsBridge(), "AndroidNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (isTrusted(uri)) return false
                // WhatsApp, SMS ve diğer dış bağlantılar uygulama içinde değil, ilgili uygulamada açılır
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (_: Exception) {
                }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // 1) Sadece kendi sitemize izin ver
                if (!isTrusted(request.origin)) {
                    request.deny()
                    return
                }
                // 2) Sadece kamera ve mikrofon (başka hiçbir kaynak yok)
                val allowed = request.resources.filter {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                }.toTypedArray()
                if (allowed.isEmpty()) {
                    request.deny()
                    return
                }
                // 3) Android izni yoksa önce kullanıcıya sor
                val needed = mutableListOf<String>()
                if (allowed.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && !hasPerm(Manifest.permission.RECORD_AUDIO)) {
                    needed.add(Manifest.permission.RECORD_AUDIO)
                }
                if (allowed.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !hasPerm(Manifest.permission.CAMERA)) {
                    needed.add(Manifest.permission.CAMERA)
                }
                if (needed.isEmpty()) {
                    request.grant(allowed)
                } else {
                    pendingWebRequest?.deny()
                    pendingWebRequest = request
                    pendingWebResources = allowed
                    ActivityCompat.requestPermissions(this@MainActivity, needed.toTypedArray(), MEDIA_PERMS_REQ)
                }
            }
        }

        webView.loadUrl(APP_URL)
    }

    private fun requestStartupPermissions() {
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        val needed = perms.filter { !hasPerm(it) }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), STARTUP_PERMS_REQ)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == MEDIA_PERMS_REQ) {
            val req = pendingWebRequest ?: return
            pendingWebRequest = null
            val allGranted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
            if (allGranted) req.grant(pendingWebResources) else req.deny()
        }
    }

    inner class NativeContactsBridge {
        @JavascriptInterface
        fun insertContact(name: String, phone: String) {
            val safeName = name.take(100)
            val safePhone = phone.filter { it.isDigit() || it == '+' }.take(20)
            if (safePhone.isEmpty()) return
            runOnUiThread {
                // Köprü sadece kendi sitemiz açıkken çalışır
                if (!isTrusted(Uri.parse(webView.url ?: ""))) return@runOnUiThread
                val intent = Intent(ContactsContract.Intents.Insert.ACTION).apply {
                    type = ContactsContract.RawContacts.CONTENT_TYPE
                    putExtra(ContactsContract.Intents.Insert.NAME, safeName)
                    putExtra(ContactsContract.Intents.Insert.PHONE, safePhone)
                }
                startActivity(intent)
            }
        }
    }
}
