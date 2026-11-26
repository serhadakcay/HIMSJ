package com.nexuschat.e2ee

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.ContactsContract
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    companion object {
        // Uygulama sadece bu adresteki siteyi açar; izinler ve köprü sadece bu siteye verilir
        private const val APP_HOST = "sermsj.onrender.com"
        private const val APP_URL = "https://$APP_HOST"
    }

    private lateinit var webView: WebView
    private var pendingWebRequest: PermissionRequest? = null
    private var pendingWebResources: Array<String> = emptyArray()
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null

    private val mediaPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
            val req = pendingWebRequest ?: return@registerForActivityResult
            pendingWebRequest = null
            if (res.values.all { it }) req.grant(pendingWebResources) else req.deny()
        }

    private val contactPicker =
        registerForActivityResult(ActivityResultContracts.PickContact()) { uri ->
            if (uri == null) sendPicked(null, null) else readContact(uri)
        }

    private val contactPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) contactPicker.launch(null)
            else sendPicked(null, "Rehber izni verilmedi. Ayarlar > Uygulamalar > NexusChat > İzinler bölümünden açabilirsiniz.")
        }

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            val cb = fileCallback
            fileCallback = null
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        }

    private val geoPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val p = pendingGeo ?: return@registerForActivityResult
            pendingGeo = null
            p.second.invoke(p.first, granted, false)
        }

    private val simplePermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    private fun isTrusted(uri: Uri?): Boolean =
        uri != null && uri.scheme == "https" && uri.host == APP_HOST

    private fun isTrustedUrl(url: String?): Boolean =
        !url.isNullOrBlank() && isTrusted(Uri.parse(url))

    private fun hasPerm(p: String): Boolean =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun startUrlFrom(intent: Intent?): String {
        val d = intent?.data
        return if (isTrusted(d)) d.toString() else APP_URL
    }

    private fun openExternal(uri: Uri) {
        try {
            val i = if (uri.scheme == "sms" || uri.scheme == "smsto") Intent(Intent.ACTION_SENDTO, uri)
            else Intent(Intent.ACTION_VIEW, uri)
            startActivity(i)
        } catch (_: Exception) {
            Toast.makeText(this, "Bu bağlantıyı açacak uygulama bulunamadı.", Toast.LENGTH_SHORT).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(true)
            userAgentString = "$userAgentString NexusChatAndroid/1.0"
        }
        CookieManager.getInstance().setAcceptCookie(true)

        webView.addJavascriptInterface(NativeBridge(), "AndroidNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (isTrusted(uri)) return false
                // WhatsApp, SMS ve diğer dış bağlantılar kendi uygulamalarında açılır
                openExternal(uri)
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleMediaRequest(request) }
            }

            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    fileChooser.launch(fileChooserParams.createIntent())
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (!isTrustedUrl(origin)) {
                    callback.invoke(origin, false, false)
                    return
                }
                if (hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeo = origin to callback
                    geoPermLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 && !hasPerm(Manifest.permission.POST_NOTIFICATIONS)) {
            simplePermLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        }

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        else webView.loadUrl(startUrlFrom(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val d = intent.data
        if (isTrusted(d)) webView.loadUrl(d.toString())
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // Kamera / mikrofon: sadece kendi sitemize ve sadece bu iki kaynağa izin verilir
    private fun handleMediaRequest(request: PermissionRequest) {
        if (!isTrusted(request.origin)) {
            request.deny(); return
        }
        val allowed = request.resources.filter {
            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
        }.toTypedArray()
        if (allowed.isEmpty()) {
            request.deny(); return
        }
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
            mediaPermLauncher.launch(needed.toTypedArray())
        }
    }

    // Seçilen kişinin adını ve TÜM numaralarını okur
    private fun readContact(uri: Uri) {
        try {
            var contactId: String? = null
            var name = ""
            contentResolver.query(
                uri,
                arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME),
                null, null, null
            )?.use { c ->
                if (c.moveToFirst()) {
                    contactId = c.getString(0)
                    name = c.getString(1) ?: ""
                }
            }
            val tels = JSONArray()
            val cid = contactId
            if (cid != null) {
                contentResolver.query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
                    "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
                    arrayOf(cid),
                    null
                )?.use { c ->
                    while (c.moveToNext()) {
                        val n = c.getString(0)
                        if (!n.isNullOrBlank()) tels.put(n)
                    }
                }
            }
            sendPicked(JSONObject().put("name", name).put("tels", tels).toString(), null)
        } catch (e: Exception) {
            sendPicked(null, "Kişi okunamadı: ${e.message}")
        }
    }

    private fun sendPicked(json: String?, error: String?) {
        val a = if (json == null) "null" else JSONObject.quote(json)
        val b = if (error == null) "null" else JSONObject.quote(error)
        webView.post {
            webView.evaluateJavascript("window.onNativeContactPicked && window.onNativeContactPicked($a, $b);", null)
        }
    }

    // ---- Sayfadaki JavaScript'in çağırabildiği köprü (window.AndroidNative) ----
    inner class NativeBridge {
        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun pickContact() {
            runOnUiThread {
                if (!isTrustedUrl(webView.url)) return@runOnUiThread
                if (hasPerm(Manifest.permission.READ_CONTACTS)) contactPicker.launch(null)
                else contactPermLauncher.launch(Manifest.permission.READ_CONTACTS)
            }
        }

        @JavascriptInterface
        fun insertContact(name: String, phone: String) {
            val safeName = name.take(100)
            val safePhone = phone.filter { it.isDigit() || it == '+' }.take(20)
            if (safePhone.isEmpty()) return
            runOnUiThread {
                if (!isTrustedUrl(webView.url)) return@runOnUiThread
                try {
                    val intent = Intent(ContactsContract.Intents.Insert.ACTION).apply {
                        type = ContactsContract.RawContacts.CONTENT_TYPE
                        putExtra(ContactsContract.Intents.Insert.NAME, safeName)
                        putExtra(ContactsContract.Intents.Insert.PHONE, safePhone)
                    }
                    startActivity(intent)
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, "Rehber uygulaması açılamadı.", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
}
