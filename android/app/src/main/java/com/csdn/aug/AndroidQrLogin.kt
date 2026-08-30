package com.csdn.aug

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject

/** 离屏扫码登录：供局域网网页端使用。App 后台拉起官方登录页（桌面 UA），抓二维码 dataURL 给前端展示，扫码成功自动采集 cookie。 */
object AndroidQrLogin {
    private const val DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    private var web: WebView? = null
    private var status = "idle" // idle|loading|qr|success|error|expired
    private var img: String? = null
    private var err: String? = null
    private var startedAt = 0L
    private val ui = Handler(Looper.getMainLooper())

    @Synchronized
    fun start(activity: Activity): JSONObject {
        if (status == "loading" || status == "qr") return JSONObject().put("running", true)
        status = "loading"; img = null; err = null; startedAt = System.currentTimeMillis()
        ui.post {
            try {
                // 起扫码前清 WebView 旧登录 cookie，避免「秒成功」收割旧会话；App 真实会话在 cookie jar 文件里，不受影响
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
                val w = WebView(activity)
                w.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    userAgentString = DESKTOP_UA
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                    textZoom = 100
                }
                val cm = CookieManager.getInstance()
                cm.setAcceptThirdPartyCookies(w, true)
                w.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) { extractQr(view) }
                }
                web = w
                w.loadUrl("https://passport.csdn.net/account/login")
                pollCookies()
            } catch (e: Exception) {
                status = "error"; err = e.message ?: "启动失败"
            }
        }
        return JSONObject().put("started", true)
    }

    private fun extractQr(view: WebView) {
        if (status != "loading") return
        view.evaluateJavascript(
            "(function(){for(const im of document.images){const r=im.getBoundingClientRect();if((im.src||'').startsWith('data:image')&&r.width>=120&&r.width<=300)return im.src;}return '';})()"
        ) { res ->
            val s = try { JSONArray("[$res]").optString(0) } catch (e: Exception) { "" }
            if (s.startsWith("data:image")) { img = s; status = "qr" }
            else if (status == "loading" && System.currentTimeMillis() - startedAt < 60000 && web != null) ui.postDelayed({ extractQr(view) }, 2500)
            else if (status == "loading") { status = "error"; err = "页面上未找到二维码（可改用 App 内登录）" }
        }
    }

    private fun pollCookies() {
        ui.postDelayed({
            if (status != "loading" && status != "qr") return@postDelayed
            val cm = CookieManager.getInstance()
            val www = cm.getCookie("https://www.csdn.net/") ?: ""
            val passport = cm.getCookie("https://passport.csdn.net/") ?: ""
            if (www.contains("UserToken=") || www.contains("UserInfo=")) {
                val arr = JSONArray()
                fun collect(raw: String, domain: String) {
                    for (pair in raw.split("; ")) {
                        val i = pair.indexOf("=")
                        if (i <= 0) continue
                        val name = pair.slice(0 until i).trim()
                        val v = pair.slice(i + 1 until pair.length).trim()
                        if (name.isEmpty() || v.isEmpty()) continue
                        arr.put(JSONObject().put("name", name).put("value", v).put("domain", domain).put("path", "/"))
                    }
                }
                collect(www, ".csdn.net")
                collect(passport, "passport.csdn.net")
                try {
                    CookieJar.import(arr.toString())
                    status = "success"
                } catch (e: Exception) { status = "error"; err = e.message ?: "采集失败" }
                destroyWeb()
            } else if (System.currentTimeMillis() - startedAt > 300000) {
                status = "expired"; err = "二维码已超时，请重新获取"
                destroyWeb()
            } else pollCookies()
        }, 2000)
    }

    private fun destroyWeb() {
        ui.post {
            try { web?.destroy() } catch (e: Exception) {}
            web = null
        }
    }

    @Synchronized
    fun reset() {
        status = "idle"; img = null; err = null
        destroyWeb()
    }

    @Synchronized
    fun statusJson(): JSONObject = JSONObject()
        .put("running", status == "loading" || status == "qr")
        .put("status", status)
        .put("err", err ?: JSONObject.NULL)
        .put("qr", img ?: JSONObject.NULL)
}
