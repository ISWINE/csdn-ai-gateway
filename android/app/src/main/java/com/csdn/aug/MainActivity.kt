package com.csdn.aug

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var web: WebView
    private var filePathCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null
    private val FILE_CHOOSER_CODE = 1001
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        Thread { WebServer(this, 3010).start() }.start()
        Thread.sleep(300)

        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                return false // 代理后的 CSDN 资源同源，全部留在 WebView 内
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(webView: WebView, callback: android.webkit.ValueCallback<Array<android.net.Uri>>, params: FileChooserParams): Boolean {
                filePathCallback = callback
                val intent = params.createIntent()
                intent.addCategory(Intent.CATEGORY_OPENABLE)
                return try {
                    startActivityForResult(intent, FILE_CHOOSER_CODE); true
                } catch (e: Exception) { filePathCallback = null; false }
            }
        }
        web.loadUrl("http://127.0.0.1:3010/")
    }

    /** 供网页 UI 调用的原生能力 */
    inner class Bridge {
        @JavascriptInterface
        fun openLogin() { ui.post { showLoginDialog() } }
    }

    /** 网页登录：WebView 桌面 UA 打开官方登录页（微信扫码），登录成功自动采集全量 cookie 热生效 */
    private fun showLoginDialog() {
        val dialog = Dialog(this)
        dialog.setTitle("登录 CSDN（成功后自动采集登录态）")
        val loginWeb = WebView(this)
        loginWeb.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            userAgentString = DESKTOP_UA
            // 关键：登录页里 http 资源（含二维码图片）默认会被拦，导致二维码渲染不出来
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            textZoom = 100
        }
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(loginWeb, true)
        // 清掉登录页历史 cookie（跟踪器/旧会话），采集数量与 PC 端对齐；App 会话在 jar 文件里不受影响
        cm.removeAllCookies(null)
        cm.flush()
        loginWeb.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                val url = request.url.toString()
                // 微信/支付宝等外跳 scheme 交给系统应用，避免 WebView 报 ERR_UNKNOWN_URL_SCHEME
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (e: Exception) {}
                    return true
                }
                return false
            }
            override fun onReceivedError(view: WebView, req: android.webkit.WebResourceRequest?, err: android.webkit.WebResourceError?) {
                // 登录专页打不开时自动退回 CSDN 首页，用站内「登录」入口照常登录
                val url = req?.url?.toString() ?: ""
                if (err != null && url.startsWith("https://passport.csdn.net") && view.url?.startsWith("https://passport.csdn.net") == true) {
                    Toast.makeText(this@MainActivity, "登录专页加载失败，已转 CSDN 首页（点页面上「登录」）", Toast.LENGTH_LONG).show()
                    view.loadUrl("https://www.csdn.net/")
                }
            }
        }
        // 顶部手动切换条：默认桌面版（微信扫码），可切手机版/首页
        val bar = android.widget.LinearLayout(this)
        bar.orientation = android.widget.LinearLayout.HORIZONTAL
        val pc = android.widget.Button(this); pc.text = "桌面版(扫码)"; pc.setOnClickListener { loginWeb.settings.userAgentString = DESKTOP_UA; loginWeb.loadUrl("https://passport.csdn.net/account/login") }
        val mb = android.widget.Button(this); mb.text = "手机版"; mb.setOnClickListener { loginWeb.settings.userAgentString = MOBILE_UA; loginWeb.loadUrl("https://passport.csdn.net/account/login") }
        val home = android.widget.Button(this); home.text = "CSDN首页"; home.setOnClickListener { loginWeb.loadUrl("https://www.csdn.net/") }
        bar.addView(pc); bar.addView(mb); bar.addView(home)
        val box = android.widget.LinearLayout(this)
        box.orientation = android.widget.LinearLayout.VERTICAL
        box.addView(bar)
        box.addView(loginWeb, android.widget.LinearLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        dialog.setContentView(box)
        dialog.window?.setLayout(android.view.WindowManager.LayoutParams.MATCH_PARENT, (resources.displayMetrics.heightPixels * 0.9).toInt())
        dialog.setOnDismissListener { loginWeb.destroy() }
        dialog.show()
        loginWeb.loadUrl("https://passport.csdn.net/account/login")
        Toast.makeText(this, "桌面版页面用微信扫码；本机微信可点页面下方「微信登录」直接跳转确认", Toast.LENGTH_LONG).show()

        var tries = 0
        val poll = object : Runnable {
            override fun run() {
                if (!dialog.isShowing) return
                tries++
                val www = cm.getCookie("https://www.csdn.net/") ?: ""
                val passport = cm.getCookie("https://passport.csdn.net/") ?: ""
                if (www.contains("UserToken=") || www.contains("UserInfo=")) {
                    val arr = org.json.JSONArray()
                    val seen = HashSet<String>()
                    fun collect(raw: String, domain: String) {
                        for (pair in raw.split("; ")) {
                            val i = pair.indexOf("=")
                            if (i <= 0) continue
                            val name = pair.slice(0 until i).trim()
                            val v = pair.slice(i + 1 until pair.length).trim()
                            if (name.isEmpty() || v.isEmpty() || !seen.add(name)) continue  // 同名去重（.csdn.net 与 www 变体）
                            arr.put(org.json.JSONObject().put("name", name).put("value", v).put("domain", domain).put("path", "/"))
                        }
                    }
                    collect(www, ".csdn.net")
                    collect(passport, "passport.csdn.net")
                    try {
                        CookieJar.import(arr.toString())
                        ui.post {
                            Toast.makeText(this@MainActivity, "✓ 登录成功，已采集 " + arr.length() + " 个 cookie，立即生效", Toast.LENGTH_LONG).show()
                            web.evaluateJavascript("try { refreshCookieStatus && refreshCookieStatus(); } catch (e) {}", null)
                        }
                        dialog.dismiss()
                    } catch (e: Exception) {
                        ui.post { Toast.makeText(this@MainActivity, "cookie 采集失败：" + e.message, Toast.LENGTH_LONG).show() }
                    }
                    return
                }
                if (tries < 400) ui.postDelayed(this, 1500) else dialog.dismiss()
            }
        }
        ui.postDelayed(poll, 2000)
    }

    private val DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    private val MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_CODE) {
            val uris = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            filePathCallback?.onReceiveValue(uris)
            filePathCallback = null
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
