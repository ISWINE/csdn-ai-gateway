package com.csdn.aug

import android.app.Activity
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.PipedInputStream
import java.io.PipedOutputStream

/**
 * 应用内嵌本地服务（全网卡 0.0.0.0:3010，局域网内浏览器可访问）：web 资产 + 全部 API + OpenAI 兼容网关。
 * 底层为自研 RawHttpServer（NanoHTTPD 2.3.1 的 header/body 同包竞态会吞掉小 POST body，弃用）。
 */
class WebServer(ctx: Context, private val port: Int) {
    private val appCtx = ctx.applicationContext
    private val activity = ctx as? Activity
    private val server = RawHttpServer(port) { req -> route(req) }

    companion object { const val APP_VERSION = "v2026.08.30" }

    fun start() = server.start()
    fun stop() = server.stop()

    private fun json(o: Any?): HttpResponse = HttpResponse.json(o)
    private fun err(code: Int, msg: String): HttpResponse = HttpResponse.err(code, msg)

    private fun historyList(): JSONArray {
        return try {
            val root = JSONObject(Store.readText("history.json") ?: "{\"sessions\":[]}")
            root.optJSONArray("sessions") ?: JSONArray()
        } catch (e: Exception) { JSONArray() }
    }

    private fun serveAsset(p0: String): HttpResponse {
        val p = if (p0 == "/" || p0.isEmpty()) "/index.html" else p0
        val mime = mapOf(
            ".html" to "text/html; charset=utf-8", ".js" to "text/javascript; charset=utf-8",
            ".css" to "text/css; charset=utf-8", ".json" to "application/json; charset=utf-8",
            ".svg" to "image/svg+xml", ".png" to "image/png", ".ico" to "image/x-icon", ".jpg" to "image/jpeg",
        ).entries.firstOrNull { p.endsWith(it.key) }?.value ?: "application/octet-stream"
        return try {
            HttpResponse.file(mime, appCtx.assets.open("www$p").readBytes())
        } catch (e: Exception) {
            HttpResponse.text(404, "not found")
        }
    }

    /** SSE 通用壳：upstreamCall 在后台线程跑，onEvent 转成 data:{json}\n\n 帧 */
    private fun sse(body: JSONObject, upstreamCall: (onEvent: (String, String) -> Unit) -> Unit): HttpResponse {
        val pis = PipedInputStream(); val pos = PipedOutputStream()
        pis.connect(pos)
        Thread {
            try {
                upstreamCall { kind, data ->
                    val o = JSONObject().put("t", kind)
                    when (kind) {
                        "done" -> { if (data == "pure") o.put("pure", true) }
                        "refs" -> o.put("refs", JSONArray(data))
                        "related" -> o.put("items", JSONArray(data))
                        "node" -> { val i = data.lastIndexOf("|"); if (i > 0) { o.put("title", data.slice(0 until i)); o.put("state", data.slice(i + 1 until data.length)) } else { o.put("title", data); o.put("state", "run") } }
                        "error" -> o.put("msg", data)
                        "answer", "think" -> if (data.isNotEmpty()) o.put("text", data)
                        else -> if (data.isNotEmpty()) o.put(kind, data)
                    }
                    pos.write("data:${o}\n\n".toByteArray()); pos.flush()
                }
            } catch (e: Exception) {} finally { try { pos.close() } catch (e: Exception) {} }
        }.start()
        return HttpResponse.sse(pis)
    }

    private fun route(req: HttpReq): HttpResponse {
        val p = req.path
        val method = req.method
        try {
            if (p == "/api/health") return json(JSONObject().put("ok", true).put("v", APP_VERSION))

            /* --- 模型 --- */
            if (p == "/api/models" && method == "GET") {
                val m = CsdnChannels.listModels()
                val sw = Registry.switches()
                val search = m.optJSONArray("search") ?: JSONArray()
                val filtered = JSONArray()
                for (i in 0 until search.length()) {
                    val s = search.optJSONObject(i) ?: continue
                    val gw = when (s.optString("id")) { "1" -> "csdn-v4-flash"; "2" -> "csdn-qwen-plus"; "3" -> "csdn-v4-flash"; "6" -> "csdn-v3-0324"; "14" -> "csdn-qwen3-32b"; "15" -> "csdn-qwen3-32b-think"; else -> null }
                    if (gw != null && !Registry.isModelEnabled(gw)) continue
                    filtered.put(s)
                }
                m.put("search", filtered)
                val agent = m.optJSONArray("agent") ?: JSONArray()
                val agentFiltered = JSONArray()
                for (i in 0 until agent.length()) {
                    val a = agent.optJSONObject(i) ?: continue
                    if (!Registry.isModelEnabled(a.optString("id"))) continue
                    agentFiltered.put(a)
                }
                m.put("agent", agentFiltered)
                return json(m)
            }

            /* --- 开关配置 --- */
            if (p == "/api/config") {
                if (method == "GET") {
                    val ws = Registry.webSearchGlobals()
                    return json(JSONObject()
                        .put("models", Registry.switches())
                        .put("registry", Registry.registryJson())
                        .put("webSearch", JSONObject().put("web", ws.first).put("api", ws.second))
                        .put("mcpEnabled", Registry.isMcpEnabled())
                        .put("uid", Registry.uid()))
                }
                val body = req.bodyJson()
                if (body.has("models")) Registry.setSwitches(body.optJSONObject("models") ?: JSONObject())
                if (body.has("webSearch")) { val ws = body.optJSONObject("webSearch") ?: JSONObject(); Registry.setWebSearchGlobals(ws.optBoolean("web", true), ws.optBoolean("api", false)) }
                if (body.has("mcpEnabled")) Registry.setMcpEnabled(body.optBoolean("mcpEnabled", true))
                if (body.has("uid")) Registry.setUid(body.optString("uid").trim())
                return json(JSONObject().put("ok", true).put("models", Registry.switches()))
            }

            /* --- 历史 --- */
            if (p == "/api/history") {
                if (method == "GET") return json(JSONObject().put("sessions", historyList()))
                if (method == "POST") {
                    val body = req.bodyJson()
                    val id = body.optString("id"); if (id.isEmpty()) return err(400, "id 必填")
                    val sessions = historyList()
                    val out = JSONArray()
                    for (i in 0 until sessions.length()) { val s = sessions.optJSONObject(i) ?: continue; if (s.optString("id") != id) out.put(s) }
                    out.put(body)
                    Store.writeText("history.json", JSONObject().put("sessions", out).toString(2))
                    return json(JSONObject().put("ok", true))
                }
            }
            if (p.startsWith("/api/history/") && method == "DELETE") {
                val id = p.removePrefix("/api/history/")
                val sessions = historyList(); val out = JSONArray()
                for (i in 0 until sessions.length()) { val s = sessions.optJSONObject(i) ?: continue; if (s.optString("id") != id) out.put(s) }
                Store.writeText("history.json", JSONObject().put("sessions", out).toString(2))
                return json(JSONObject().put("ok", true))
            }

            /* --- 登录 / Cookie（安卓无扫码弹窗，支持导入与退出） --- */
            if (p == "/api/auth/status" && method == "GET") {
                val s = CookieJar.status()
                s.put("qrRunning", false); s.put("qrLines", JSONArray()); s.put("qrSuccess", false)
                return json(s)
            }
            if (p == "/api/auth/import" && method == "POST") {
                val text = req.bodyJson().optString("text")
                return try {
                    val (count, hasToken) = CookieJar.import(text)
                    json(JSONObject().put("ok", true).put("count", count).put("hasUserToken", hasToken)
                        .put("warn", if (hasToken) null else "未检测到 UserToken/UserInfo——导入的可能不是登录态 cookie"))
                } catch (e: Exception) { err(400, e.message ?: "导入失败") }
            }
            if (p == "/api/auth/logout" && method == "POST") {
                CookieJar.logout()
                // 附带清空 WebView 持久化登录态（内嵌登录的 cookie 存在系统 CookieManager，不清会导致再点登录直接回滚旧账号）
                try {
                    val cm = android.webkit.CookieManager.getInstance()
                    cm.removeAllCookies(null)
                    cm.flush()
                } catch (e: Exception) {}
                AndroidQrLogin.reset()
                return json(JSONObject().put("ok", true).put("note", "已清空 cookie 与 WebView 登录态（原文件已备份 .bak）"))
            }
            /* --- 扫码登录（局域网网页端）：离屏 WebView 出二维码，扫码后自动采集 --- */
            if (p == "/api/auth/qr2/start" && method == "POST") {
                val a = activity ?: return err(500, "登录入口仅在 App 内可用")
                return json(AndroidQrLogin.start(a))
            }
            if (p == "/api/auth/qr2/status" && method == "GET") return json(AndroidQrLogin.statusJson())

            /* --- Cookie 文件导出 + 局域网访问信息 --- */
            if (p == "/api/auth/export" && method == "GET") {
                return HttpResponse(200, "application/json; charset=utf-8", CookieJar.load().toString(2).toByteArray(),
                    extraHeaders = mapOf("Content-Disposition" to "attachment; filename=\"csdn-cookies.json\""))
            }
            if (p == "/api/lan-info" && method == "GET") {
                var ip: String? = null
                val nis = java.net.NetworkInterface.getNetworkInterfaces()
                while (nis.hasMoreElements() && ip == null) {
                    val nif = nis.nextElement()
                    val addrs = nif.inetAddresses
                    while (addrs.hasMoreElements()) {
                        val a = addrs.nextElement()
                        if (!a.isLoopbackAddress && a is java.net.Inet4Address) { ip = a.hostAddress; break }
                    }
                }
                return json(JSONObject().put("ip", ip ?: JSONObject.NULL).put("port", port))
            }

            /* --- 上传（body 为 JSON：{name, data(base64)}，二进制安全） --- */
            if (p == "/api/upload" && method == "POST") {
                val upBody = req.bodyJson()
                val upName = (upBody.optString("name", "upload.md")).replace(Regex("[\\\\/:*?\"<>|]"), "_")
                val bytes = try {
                    android.util.Base64.decode(upBody.optString("data"), android.util.Base64.DEFAULT)
                } catch (e: Exception) { ByteArray(0) }
                if (bytes.isEmpty()) return err(400, "空文件")
                return try {
                    if (req.q("target") == "search") {
                        json(JSONObject().put("docId", CsdnChannels.uploadDoc(bytes, upName)).put("fileName", upName))
                    } else {
                        val url = CsdnChannels.phoenixUpload(bytes, upName)
                        json(JSONObject().put("file_url", url).put("fileName", upName))
                    }
                } catch (e: Exception) { err(500, (e.message ?: "上传失败").slice(0 until minOf(200, (e.message ?: "上传失败").length))) }
            }

            /* --- 工具模式后端：内部转调 /v1（deepseek-chat 自带空回复重试） --- */
            if (p == "/api/fast" && method == "POST") {
                val body = req.bodyJson()
                val gwBody = JSONObject().put("model", "deepseek-chat")
                    .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", body.optString("query"))))
                    .toString().toByteArray()
                val gwReq = HttpReq("POST", "/v1/chat/completions", emptyMap(), mapOf("content-length" to gwBody.size.toString()), gwBody)
                val gwResp = route(gwReq)
                val out = try { JSONObject(String(gwResp.body ?: ByteArray(0), Charsets.UTF_8)) } catch (e: Exception) { JSONObject() }
                val text = out.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: ""
                return json(JSONObject().put("text", text.trim()))
            }

            /* --- 三通道 SSE --- */
            if (p == "/api/chat" || p == "/api/agent" || p == "/api/search") {
                val body = req.bodyJson()
                return sse(body) { onEvent ->
                    when (p) {
                        "/api/chat" -> CsdnChannels.chatStream(body.optString("message"), body.optJSONArray("history") ?: JSONArray(), onEvent)
                        "/api/agent" -> {
                            var answerChars = 0
                            val wrapped: (String, String) -> Unit = { kind, data ->
                                if (kind == "answer") answerChars += data.length
                                onEvent(kind, data)
                            }
                            CsdnChannels.agentStream(body.optJSONArray("messages") ?: JSONArray(), body.optString("model", "csdn-agent-flash"), body.optString("fileUrl", ""), wrapped)
                            if (answerChars == 0) {
                                val msgs = body.optJSONArray("messages") ?: JSONArray()
                                var lastUser = ""
                                for (i in 0 until msgs.length()) { val m = msgs.optJSONObject(i); if (m != null && m.optString("role") == "user") lastUser = m.optString("content") }
                                onEvent("answer", "（智能体通道无响应，已转直连通道）\n\n")
                                CsdnChannels.chatStream(lastUser, JSONArray(), onEvent)
                            }
                        }
                        else -> {
                            val (webG, apiG) = Registry.webSearchGlobals()
                            CsdnChannels.searchStream(
                                body.optString("query"),
                                if (webG && body.optString("webSearch") == "1") "1" else "0",
                                body.optString("modelId", "1"),
                                body.optBoolean("pure"),
                                body.optString("docIds", ""),
                                body.optString("sid", ""),
                                onEvent,
                            ) { sid -> onEvent("sid", sid) }
                        }
                    }
                }
            }

            /* --- 诊断（临时）：ai-middle 原始响应 --- */
            if (p == "/api/dbg" && method == "GET") {
                val msg = req.q("q") ?: "你好"
                val body = JSONObject().put("think", true).put("content", msg).put("prompt", "").put("biz_no", "blog").put("sub_biz_no", "blog_writer_md")
                val cookieCount = try { CookieJar.load().length() } catch (e: Exception) { -1 }
                val c = CsdnChannels.debugChat(body.toString().toByteArray())
                val head = StringBuilder()
                head.append("cookies=").append(cookieCount).append("\nstatus=").append(c.responseCode).append("\n--- body 前600 ---\n")
                try { head.append(c.inputStream.bufferedReader().readText().take(600)) } catch (e: Exception) { head.append("(读body失败 ").append(e.message).append(")") }
                return HttpResponse.text(200, head.toString())
            }

            /* ===== OpenAI 兼容网关 ===== */
            if (p == "/v1/models" && method == "GET") {
                // 模型名带 @middle/@phoenix/@dify 后缀（IDE 列表可见通道）；请求时服务端剥离后缀再路由
                val tagged = listOf(
                    "deepseek-chat@middle", "deepseek-reasoner@middle",
                    "csdn-agent-flash@phoenix", "csdn-agent-pro@phoenix",
                    "csdn-v3-0324@dify", "csdn-qwen3-32b@dify", "csdn-qwen3-32b-think@dify",
                    "csdn-qwen-plus@dify", "csdn-v4-flash@dify",
                )
                val owner = mapOf(
                    "deepseek-chat" to "csdn-ai-middle", "deepseek-reasoner" to "csdn-ai-middle",
                    "csdn-agent-flash" to "csdn-phoenix", "csdn-agent-pro" to "csdn-phoenix",
                    "csdn-v3-0324" to "csdn-dify", "csdn-qwen3-32b" to "csdn-dify", "csdn-qwen3-32b-think" to "csdn-dify",
                    "csdn-qwen-plus" to "csdn-dify", "csdn-v4-flash" to "csdn-dify",
                )
                val arr = JSONArray()
                for (m in tagged) {
                    val base = m.substringBefore("@")
                    if (Registry.ALL_MODELS.containsKey(base) && !Registry.isModelEnabled(base)) continue
                    arr.put(JSONObject().put("id", m).put("object", "model").put("owned_by", owner[base]))
                }
                return json(JSONObject().put("object", "list").put("data", arr))
            }
            if (p == "/v1/chat/completions" && method == "POST") {
                val body = req.bodyJson()
                val stream = body.optBoolean("stream", false)
                return openAiChat(body.optString("model", "deepseek-chat"), body.optJSONArray("messages") ?: JSONArray(), stream)
            }

            /* --- MCP「全模态解析」（streamable HTTP，局域网客户端直连手机） --- */
            if (p == "/mcp" && method == "POST") {
                if (!Registry.isMcpEnabled()) return HttpResponse(503, "application/json; charset=utf-8",
                    JSONObject().put("jsonrpc", "2.0").put("id", JSONObject.NULL)
                        .put("error", JSONObject().put("code", -32000).put("message", "MCP 已在设置面板停用")).toString().toByteArray())
                val resp = McpServer.dispatch(req.bodyJson())
                return if (resp == null) HttpResponse.text(202, "accepted") else json(resp)
            }
            if (p == "/mcp" && method == "GET") return HttpResponse.text(200, "csdn-aggregate MCP: POST JSON-RPC 2.0 到此端点（streamable HTTP）")

            /* --- 静态资产 --- */
            if (method == "GET") return serveAsset(p)
            return err(404, "not found")
        } catch (e: Exception) {
            android.util.Log.e("csdn-aug", "route异常: " + e::class.java.name + " " + e.message, e)
            return err(500, (e::class.java.simpleName + ": " + (e.message ?: "")))
        }
    }

    /* ---------- OpenAI /v1/chat/completions 实现 ---------- */

    /** messages[] → (history, 末条用户消息)；system 忽略（ai-middle 无 system 通道，与 PC 网关一致） */
    private fun splitMessages(msgs: JSONArray): Pair<JSONArray, String> {
        val turns = mutableListOf<Pair<String, String>>()
        for (i in 0 until msgs.length()) {
            val m = msgs.optJSONObject(i) ?: continue
            if (m.optString("role") == "system") continue
            val c = m.opt("content")
            val text = when (c) {
                is JSONArray -> {
                    val sb = StringBuilder()
                    for (k in 0 until c.length()) { val b = c.optJSONObject(k); if (b != null) sb.append(b.optString("text")) }
                    sb.toString()
                }
                else -> c?.toString() ?: ""
            }
            turns.add(Pair(m.optString("role"), text))
        }
        var message = ""
        var messageIdx = -1
        for (i in turns.indices.reversed()) if (turns[i].first == "user") { message = turns[i].second; messageIdx = i; break }
        if (messageIdx == -1 && turns.isNotEmpty()) { message = turns.last().second; messageIdx = turns.size - 1 }
        val history = JSONArray()
        for (i in turns.indices) if (i != messageIdx) history.put(JSONObject().put("role", turns[i].first).put("content", turns[i].second))
        return Pair(history, message)
    }

    /** 抽取 messages 里的 base64 附件（OpenAI 多模态 content 格式）→ 上传 phoenix → file_url。
     *  文档分析仅 phoenix 通道支持；地址一律来自上传服务响应，不在本地拼装。 */
    private fun extractFileUrl(msgs: JSONArray): String? {
        for (i in 0 until msgs.length()) {
            val m = msgs.optJSONObject(i) ?: continue
            val c = m.opt("content") ?: continue
            if (c !is JSONArray) continue
            for (k in 0 until c.length()) {
                val part = c.optJSONObject(k) ?: continue
                val fileObj = part.optJSONObject("file")
                val dataUrl = when (part.optString("type")) {
                    "image_url" -> part.optJSONObject("image_url")?.optString("url") ?: ""
                    "file" -> fileObj?.optString("file_data", "") ?: (fileObj?.optString("url") ?: "")
                    "input_file" -> part.optJSONObject("input_file")?.optString("file_data") ?: ""
                    else -> ""
                }
                if (dataUrl.isEmpty()) continue
                // data: 直接解码；http(s) 由手机下载后再转存（云端分析拿到的必须是公网地址，局域网地址必然 OCR/解析失败）
                val bytes: ByteArray
                var ext = "bin"
                if (dataUrl.startsWith("data:")) {
                    val comma = dataUrl.indexOf(',')
                    if (comma <= 0) continue
                    val mime = Regex("data:([^;]+);").find(dataUrl)?.groupValues?.get(1) ?: "application/octet-stream"
                    ext = mime.substringAfter('/').ifEmpty { "bin" }
                    bytes = try { android.util.Base64.decode(dataUrl.substring(comma + 1), android.util.Base64.DEFAULT) } catch (e: Exception) { continue }
                } else if (dataUrl.startsWith("http://") || dataUrl.startsWith("https://")) {
                    val c = java.net.URL(dataUrl).openConnection() as java.net.HttpURLConnection
                    c.connectTimeout = 15000; c.readTimeout = 60000
                    c.instanceFollowRedirects = true
                    try {
                        if (c.responseCode != 200) throw Exception("附件下载 HTTP " + c.responseCode)
                        bytes = c.inputStream.use { it.readBytes() }
                        ext = (c.contentType ?: "").substringAfter('/').substringBefore(';').ifEmpty { "bin" }
                    } finally { c.disconnect() }
                } else continue
                if (bytes.isEmpty()) continue
                val fn = if (fileObj != null) fileObj.optString("filename", "") else ""
                val name = (if (fn.isNotEmpty()) fn else "upload." + ext)
                    .replace(Regex("[\\\\/:*?\"<>|]"), "_")
                return CsdnChannels.phoenixUpload(bytes, name)
            }
        }
        return null
    }

    /** content 归一为纯文本（数组格式只取 text 块，避免 base64 附件整串混进 prompt） */
    private fun contentText(m: JSONObject): String {
        val c = m.opt("content") ?: return ""
        if (c is JSONArray) {
            val sb = StringBuilder()
            for (k in 0 until c.length()) { val b = c.optJSONObject(k); if (b != null && b.optString("type") == "text") sb.append(b.optString("text")) }
            return sb.toString()
        }
        return c.toString()
    }

    /** 模型路由：phoenix（agent 通道）/ dify（AI 搜索快模型）/ aimiddle（deepseek-chat 兜底）。别名不写死在前端 */
    private fun routeModel(model: String): Triple<String, String, String> {
        if (model == "deepseek-v4-pro") return Triple("phoenix", "csdn-agent-pro", "")
        if (model == "deepseek-v4-flash") return Triple("phoenix", "csdn-agent-flash", "")
        if (CsdnChannels.AGENT_MODELS.containsKey(model)) return Triple("phoenix", model, "")
        val difyId = CsdnChannels.DIFY_SET[model]
        if (difyId != null) return Triple("dify", model, difyId)
        return Triple("aimiddle", model, "")
    }

    private fun openAiChat(model: String, msgs: JSONArray, stream: Boolean): HttpResponse {
        val id = "chatcmpl-" + java.util.UUID.randomUUID().toString().replace("-", "").take(12)
        val created = System.currentTimeMillis() / 1000
        val (history, message) = splitMessages(msgs)
        val fileUrl = extractFileUrl(msgs)
        val (channel, routedModel, difyId) = routeModel(model.substringBefore("@"))
        // 模型开关：设置面板停用的模型拒绝服务（未知名单不拦，走 ai-middle 兜底）
        if (Registry.ALL_MODELS.containsKey(routedModel) && !Registry.isModelEnabled(routedModel))
            return HttpResponse(403, "application/json; charset=utf-8",
                JSONObject().put("error", JSONObject().put("message", "模型「" + routedModel + "」已在设置面板停用").put("type", "model_disabled")).toString().toByteArray())

        fun dispatch(onEvent: (String, String) -> Unit) {
            // 带附件必须走 phoenix（文档分析）；agent 模型也走 phoenix
            if (fileUrl != null || channel == "phoenix") {
                val arr = JSONArray()
                for (i in 0 until msgs.length()) {
                    val m = msgs.optJSONObject(i) ?: continue
                    if (m.optString("role") == "system") continue
                    arr.put(JSONObject().put("role", m.optString("role")).put("content", contentText(m)))
                }
                CsdnChannels.agentStream(arr, routedModel, fileUrl ?: "", onEvent)
            } else if (channel == "dify") {
                val apiWeb = if (Registry.webSearchGlobals().second) "1" else "0"
                CsdnChannels.difyChat(message, difyId, apiWeb, onEvent)
            } else {
                CsdnChannels.chatStream(message, history, onEvent)
            }
        }

        if (!stream) {
            val think = StringBuilder(); val answer = StringBuilder()
            var attempt = 0; var errMsg = ""
            while (attempt < 2 && answer.isEmpty() && errMsg.isEmpty()) {
                attempt++
                think.setLength(0)
                dispatch { kind, data ->
                    when (kind) {
                        "think" -> think.append(data)
                        "answer" -> answer.append(data)
                        "error" -> errMsg = data
                    }
                }
            }
            if (answer.isEmpty() && errMsg.isNotEmpty())
                return HttpResponse(500, "application/json; charset=utf-8",
                    JSONObject().put("error", JSONObject().put("message", errMsg).put("type", "upstream_error").put("code", "upstream_error")).toString().toByteArray())
            val msg = JSONObject().put("role", "assistant").put("content", answer.toString())
            if (think.isNotEmpty()) msg.put("reasoning_content", think.toString())
            val resp = JSONObject()
                .put("id", id).put("object", "chat.completion").put("created", created).put("model", model)
                .put("choices", JSONArray().put(JSONObject().put("index", 0).put("message", msg).put("finish_reason", "stop")))
                .put("usage", JSONObject().put("prompt_tokens", 0).put("completion_tokens", 0).put("total_tokens", 0))
            return HttpResponse(200, "application/json; charset=utf-8", resp.toString().toByteArray())
        }

        val pis = PipedInputStream(); val pos = PipedOutputStream()
        pis.connect(pos)
        Thread {
            fun frame(delta: JSONObject, finish: Any? = JSONObject.NULL): String {
                val chunk = JSONObject()
                    .put("id", id).put("object", "chat.completion.chunk").put("created", created).put("model", model)
                    .put("choices", JSONArray().put(JSONObject().put("index", 0).put("delta", delta).put("finish_reason", finish)))
                return "data:" + chunk + "\n\n"
            }
            try {
                pos.write(frame(JSONObject()).toByteArray()); pos.flush()
                var attempt = 0; var got = 0; var errMsg = ""
                while (attempt < 2 && got == 0 && errMsg.isEmpty()) {
                    attempt++
                    dispatch { kind, data ->
                        when (kind) {
                            "think" -> if (data.isNotEmpty()) { pos.write(frame(JSONObject().put("reasoning_content", data)).toByteArray()); pos.flush() }
                            "answer" -> if (data.isNotEmpty()) { got += data.length; pos.write(frame(JSONObject().put("content", data)).toByteArray()); pos.flush() }
                            "error" -> errMsg = data
                        }
                    }
                }
                if (errMsg.isNotEmpty()) {
                    pos.write(frame(JSONObject().put("content", "（上游错误：" + errMsg + "）")).toByteArray()); pos.flush()
                }
                pos.write(frame(JSONObject(), "stop").toByteArray())
                pos.write("data: [DONE]\n\n".toByteArray()); pos.flush()
            } catch (e: Exception) {
            } finally { try { pos.close() } catch (e: Exception) {} }
        }.start()
        return HttpResponse.sse(pis)
    }
}
