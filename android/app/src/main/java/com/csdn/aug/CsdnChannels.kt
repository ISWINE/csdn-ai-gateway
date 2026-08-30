package com.csdn.aug

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** 三通道（chat/agent/search）+ 模型列表 + 文档上传。SSE 增量通过 onEvent(kind, data) 回调。 */
object CsdnChannels {
    const val AI_MIDDLE = "https://bizapi.csdn.net/ai-middle/gpt/assistant"
    const val AGENT_CHAT = "https://bizapi.csdn.net/blog/phoenix/console/v1/stream/ai/assistant/agent-chat"
    const val PHOENIX_UPLOAD = "https://bizapi.csdn.net/blog/phoenix/console/v1/ai/file/doc/upload"
    const val AIS_BASE = "https://bizapi.csdn.net"

    val AGENT_MODELS = linkedMapOf(
        "csdn-agent-flash" to "markdown_editor/deepseek-v4-flash",
        "csdn-agent-pro" to "markdown_editor/deepseek-v4-pro",
    )
    val DIFY_SET = linkedMapOf(
        "csdn-v3-0324" to "6", "csdn-qwen3-32b" to "14", "csdn-qwen3-32b-think" to "15",
        "csdn-qwen-plus" to "2", "csdn-v4-flash" to "3",
    )

    private const val TAG = "csdn-aug"
    private var modelCache: Pair<Long, JSONObject>? = null

    private fun open(method: String, url: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Int = 300000): HttpURLConnection {
        android.util.Log.d(TAG, method + " " + url)
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 20000
        c.readTimeout = timeoutMs
        for ((k, v) in headers) c.setRequestProperty(k, v)
        if (body != null) {
            c.doOutput = true
            c.outputStream.use { it.write(body) }
        }
        return c
    }

    private fun readSSE(input: java.io.InputStream, onData: (String) -> Boolean) {
        val reader = BufferedReader(InputStreamReader(input, Charsets.UTF_8))
        while (true) {
            val line = reader.readLine() ?: break
            val t = line.trim()
            if (t.startsWith("data:")) {
                if (!onData(t.substring(5).trim())) break
            }
        }
        input.close()
    }

    /** <think> 切分器（容忍标签跨 chunk 断裂） */
    private class ThinkSplitter(val emit: (String, String) -> Unit) {
        var inThink = false
        var buf = ""
        fun holdTag(s: String, tag: String): Int {
            val max = minOf(s.length, tag.length - 1)
            for (k in max downTo 1) if (s.endsWith(tag.slice(0 until k))) return k
            return 0
        }
        fun feed(chunk: String) {
            buf += chunk
            while (true) {
                if (inThink) {
                    val e = buf.indexOf("</think>")
                    if (e == -1) {
                        val hold = holdTag(buf, "</think>")
                        if (hold > 0) {
                            if (buf.length > hold) emit("think", buf.slice(0 until buf.length - hold))
                            buf = buf.slice(buf.length - hold until buf.length)
                        } else {
                            if (buf.isNotEmpty()) emit("think", buf)
                            buf = ""
                        }
                        return
                    }
                    if (e > 0) emit("think", buf.slice(0 until e))
                    buf = buf.slice(e + 8 until buf.length)
                    inThink = false
                    emit("think-end", "")
                } else {
                    val o = buf.indexOf("<think>")
                    if (o == -1) {
                        val hold = holdTag(buf, "<think>")
                        if (hold > 0) {
                            if (buf.length > hold) emit("answer", buf.slice(0 until buf.length - hold))
                            buf = buf.slice(buf.length - hold until buf.length)
                        } else {
                            if (buf.isNotEmpty()) emit("answer", buf)
                            buf = ""
                        }
                        return
                    }
                    if (o > 0) emit("answer", buf.slice(0 until o))
                    buf = buf.slice(o + 7 until buf.length)
                    inThink = true
                    emit("think-start", "")
                }
            }
        }
        fun flush() {
            if (buf.isNotEmpty()) emit(if (inThink) "think" else "answer", buf)
            buf = ""
        }
    }

    private fun buildContent(history: JSONArray, message: String): String {
        val turns = mutableListOf<String>()
        for (i in 0 until history.length()) {
            val m = history.optJSONObject(i) ?: continue
            turns.add(if (m.optString("role") == "user") "用户：${m.optString("content")}" else "助手：${m.optString("content")}")
        }
        turns.add("用户：$message")
        return turns.joinToString("\n\n")
    }

    /** Dify 快模型聚合问答（/v1 路由用）：think 切分后经 onEvent 输出（answer/think/done/error） */
    fun difyChat(query: String, modelId: String, webSearch: String, onEvent: (String, String) -> Unit) {
        val sp = ThinkSplitter { t, text -> onEvent(t, text) }
        var errored: String? = null
        var answered = false
        searchStream(query, webSearch, modelId, false, "", "", { kind, data ->
            when (kind) {
                "answer" -> { answered = true; sp.feed(data) }
                "error" -> errored = data
                "done" -> { sp.flush(); onEvent("done", "") }
                else -> {}
            }
        }, { })
        if (!answered && errored != null) onEvent("error", errored ?: "Dify 错误")
    }

    /** chat：ai-middle 通道 */
    fun chatStream(message: String, history: JSONArray, onEvent: (String, String) -> Unit) {
        val body = JSONObject()
            .put("think", true)
            .put("content", buildContent(history, message))
            .put("prompt", "").put("biz_no", "blog").put("sub_biz_no", "blog_writer_md")
        val c = open("POST", AI_MIDDLE, Signer.oldHeaders("POST", AI_MIDDLE, "application/json", "https://app-blog.csdn.net/"), body.toString().toByteArray())
        if (c.responseCode != 200) {
            val errBody = try { c.errorStream?.bufferedReader()?.readText()?.take(160) } catch (e2: Exception) { "" }
            android.util.Log.w(TAG, "HTTP " + c.responseCode + " [" + AI_MIDDLE + "] body=" + errBody)
            onEvent("error", "上游 HTTP " + c.responseCode + " " + errBody)
            return
        }
        var answerCache = 0; var thinkCache = 0
        val sp = ThinkSplitter { t, text ->
            if (t == "answer") answerCache += text.length
            if (t == "think") thinkCache += text.length
            android.util.Log.d(TAG, "[chat] ev " + t + " len=" + text.length)
            onEvent(t, text)
        }
        readSSE(c.inputStream) { payload ->
            if (payload.isEmpty() || payload == "[DONE]") return@readSSE true
            try {
                val j = JSONObject(payload)
                if (j.optInt("code") == 200) sp.feed(j.optString("text"))
                else if (j.has("msg")) onEvent("error", j.optString("msg"))
            } catch (e: Exception) {}
            true
        }
        sp.flush()
        android.util.Log.d(TAG, "[chat] 结束 answerLen=" + answerCache + " thinkLen=" + thinkCache)
        onEvent("done", "")
    }

    /** 平台内部工具反馈（第 N 条 xxx 无效/成功…）整行过滤；「用户可见输出」为空才触发重试 */
    private val TOOL_CHATTER = Regex("(?m)^[^\\n]*第\\s*\\d+\\s*条[^\\n]*(无效|成功)[^\\n]*\\n?")

    /** agent：phoenix 通道（累积答案还原增量 + attempt_completion 产物）。fileUrl 非空走官方文档分析入口（kwargs.file_url）。
     *  空输出自动重试一次；最终正文若非流式累计内容的前缀（混入工具反馈），整段补发。 */
    fun agentStream(messages: JSONArray, model: String, fileUrl: String, onEvent: (String, String) -> Unit) {
        val upstream = AGENT_MODELS[model] ?: "markdown_editor/deepseek-v4-flash"
        var finalOut = ""
        var artifactOut = ""
        for (attempt in 1..2) {
            var query = messages
            if (attempt > 1 && messages.length() > 0) {
                query = JSONArray()
                for (i in 0 until messages.length()) messages.optJSONObject(i)?.let { query.put(it) }
                val lastIdx = query.length() - 1
                val lastMsg = query.optJSONObject(lastIdx) ?: JSONObject()
                query.put(lastIdx, JSONObject()
                    .put("role", lastMsg.optString("role"))
                    .put("content", lastMsg.optString("content") + "\n\n（上一次没有输出任何正文。请跳过工具调用，直接完整输出结果正文。）"))
            }
            val kwargs = JSONObject()
            if (fileUrl.isNotEmpty()) kwargs.put("file_url", fileUrl)
            val body = JSONObject()
                .put("model", upstream)
                .put("query", query)
                .put("request_id", UUID.randomUUID().toString())
                .put("kwargs", kwargs)
                .put("extra_body", JSONObject())
            val c = open("POST", AGENT_CHAT, Signer.oldHeaders("POST", AGENT_CHAT, "application/json", "https://app-blog.csdn.net/"), body.toString().toByteArray())
            if (c.responseCode != 200) {
                val errBody = try { c.errorStream?.bufferedReader()?.readText()?.take(160) } catch (e2: Exception) { "" }
                android.util.Log.w(TAG, "HTTP " + c.responseCode + " [" + AGENT_CHAT + "] body=" + errBody)
                onEvent("error", "上游 HTTP " + c.responseCode + " " + errBody)
                return
            }
            var answer = ""
            var artifact = ""
            var emitted = 0
            readSSE(c.inputStream) { payload ->
                if (payload == "[DONE]" || payload == "[TASK_DONE]") return@readSSE false
                try {
                    val j = JSONObject(payload)
                    val meta = j.optJSONObject("meta") ?: JSONObject()
                    val msg = j.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message") ?: return@readSSE true
                    when (meta.optString("type")) {
                        "answer" -> {
                            val content = msg.optString("content")
                            if (content.length > answer.length && content.startsWith(answer)) {
                                val delta = content.slice(answer.length until content.length)
                                if (!TOOL_CHATTER.containsMatchIn(delta)) { onEvent("answer", delta); emitted += delta.length }
                                answer = content
                            } else if (content.length > answer.length) {
                                answer = content
                            }
                        }
                        "tool" -> {
                            val tool = try { JSONObject(msg.optString("content", "{}")) } catch (e: Exception) { JSONObject() }
                            val params = tool.optJSONObject("params") ?: JSONObject()
                            val cand = listOf("result", "content", "text").mapNotNull { k -> params.optString(k, "").takeIf { it.isNotEmpty() } }.firstOrNull()
                            if (cand != null && cand.length > artifact.length) artifact = cand
                        }
                    }
                } catch (e: Exception) {}
                true
            }
            val finalText = if (artifact.length > answer.length) artifact else answer
            finalOut = finalText.replace(TOOL_CHATTER, "")
            artifactOut = artifact.replace(TOOL_CHATTER, "")
            if (finalText.length > answer.length) {
                if (finalText.startsWith(answer)) {
                    val tail = finalText.slice(answer.length until finalText.length).replace(TOOL_CHATTER, "")
                    if (tail.isNotBlank()) { onEvent("answer", tail); emitted += tail.length }
                } else {
                    val block = ("\n\n---\n\n" + finalText).replace(TOOL_CHATTER, "")
                    onEvent("answer", block); emitted += block.length
                }
            }
            if (emitted > 0) break
        }
        // 成品产物（attempt_completion）优先供编辑器同步；final 为滤噪后的完整回答
        if (artifactOut.isNotEmpty()) onEvent("artifactText", artifactOut)
        if (finalOut.isNotEmpty()) onEvent("final", finalOut)
        onEvent("done", "")
    }

    private fun createAisSession(): String {
        val url = "$AIS_BASE/aisearch/v2/api/smart/session/create"
        val c = open("POST", url, Signer.oldHeaders("POST", url, "application/json", "https://i-search.csdn.net/"), "{}".toByteArray())
        return JSONObject(c.inputStream.bufferedReader().readText()).optJSONObject("data")?.optString("sid") ?: throw Exception("session 创建失败")
    }

    private fun extractRefs(v: Any?, out: MutableList<JSONObject>, seen: MutableSet<String>) {
        when (v) {
            is JSONArray -> for (i in 0 until v.length()) extractRefs(v.opt(i), out, seen)
            is JSONObject -> {
                val title = v.optString("title", "")
                val url = v.optString("url", "")
                if (title.isNotEmpty() && url.startsWith("http")) {
                    if (!seen.contains(url)) {
                        seen.add(url)
                        out.add(JSONObject().put("title", title).put("url", url))
                    }
                } else for (k in v.keys()) extractRefs(v.opt(k), out, seen)
            }
        }
    }

    /** search：Dify RAG 流式。docIds 非空走文档分析（联网自动关）；pure=true 拿到引用即止 */
    fun searchStream(query: String, webSearch: String, modelId: String, pure: Boolean, docIds: String, sid: String, onEvent: (String, String) -> Unit, onSid: (String) -> Unit) {
        val ws = if (docIds.isNotEmpty()) "0" else webSearch
        val sessId = sid.ifEmpty { createAisSession() }
        onSid(sessId)
        val body = JSONObject()
            .put("inputs", JSONObject().put("docIds", docIds).put("modelId", modelId).put("platform", "pc").put("url", "").put("webSearch", ws))
            .put("query", query).put("queryId", "").put("sessionId", sessId).put("trace_id", UUID.randomUUID().toString())
        val path = AIS_BASE + "/aisearch/v2/api/stream/smart/chat/message/stream?sign=" + Signer.qsSign(body, listOf("query", "queryId", "sessionId"))
        val c = open("POST", path, Signer.casHeaders("POST", path, "application/json", "https://i-search.csdn.net/"), body.toString().toByteArray())
        if (c.responseCode != 200) {
            val errBody = try { c.errorStream?.bufferedReader()?.readText()?.take(160) } catch (e2: Exception) { "" }
            android.util.Log.w(TAG, "HTTP " + c.responseCode + " [" + path + "] body=" + errBody)
            onEvent("error", "上游 HTTP " + c.responseCode + " " + errBody)
            return
        }
        var refsSent = false
        var answerStarted = false
        var stopped = false
        readSSE(c.inputStream) { payload ->
            if (stopped || payload.isEmpty() || payload == "[DONE]" || payload == "[CLOSE]") return@readSSE !stopped
            try {
                val j = JSONObject(payload)
                when (j.optString("event")) {
                    "node_started" -> onEvent("node", (j.optJSONObject("data")?.optString("title") ?: "") + "|run")
                    "node_finished" -> {
                        val data = j.optJSONObject("data") ?: return@readSSE true
                        val title = data.optString("title")
                        onEvent("node", title + "|" + data.optString("status"))
                        val outputs = data.optJSONObject("outputs")
                        if (outputs != null) {
                            if (!refsSent && Regex("搜索|search", RegexOption.IGNORE_CASE).containsMatchIn(title)) {
                                val refs = mutableListOf<JSONObject>()
                                val seen = HashSet<String>()
                                extractRefs(outputs, refs, seen)
                                if (refs.isNotEmpty()) { refsSent = true; onEvent("refs", JSONArray(refs).toString()) }
                            }
                            if (pure && refsSent && !stopped) {
                                stopped = true
                                onEvent("done", "pure")
                                return@readSSE false
                            }
                        }
                    }
                    "message" -> {
                        val a = j.optString("answer", "\u0000")
                        if (a != "\u0000") {
                            if (!answerStarted) { answerStarted = true; onEvent("answer-start", "") }
                            if (a.isNotEmpty()) onEvent("answer", a)
                        }
                    }
                    "message_end" -> onEvent("done", "")
                    "error" -> onEvent("error", j.optString("msg", "Dify 错误"))
                }
            } catch (e: Exception) {}
            !stopped
        }
        if (!stopped) onEvent("done", "")
    }

    @Synchronized
    fun listModels(): JSONObject {
        modelCache?.let { if (System.currentTimeMillis() - it.first < 600000) return it.second }
        val out = JSONObject()
        val search = JSONArray()
        try {
            val url = AIS_BASE + "/aisearch/v2/api/smart/llm/model/list"
            val c = open("GET", url, Signer.oldHeaders("GET", url, "application/json", "https://i-search.csdn.net/"), null)
            val arr = JSONObject(c.inputStream.bufferedReader().readText()).optJSONArray("data") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val m = arr.optJSONObject(i) ?: continue
                search.put(JSONObject().put("id", m.optString("modelId")).put("name", m.optString("modelName")).put("desc", m.optString("description")))
            }
        } catch (e: Exception) { out.put("searchError", e.message) }
        val agent = JSONArray()
        for ((k, v) in AGENT_MODELS) agent.put(JSONObject().put("id", k).put("name", k).put("upstream", v))
        out.put("search", search)
        out.put("agent", agent)
        modelCache = Pair(System.currentTimeMillis(), out)
        return out
    }

    /** 诊断用：返回原始连接（WebServer 读状态码和 body） */
    fun debugChat(body: ByteArray): HttpURLConnection =
        open("POST", AI_MIDDLE, Signer.oldHeaders("POST", AI_MIDDLE, "application/json", "https://app-blog.csdn.net/"), body)

    /** 文档上传：aisearch docUpload（docFile 字段）→ docId */
    fun uploadDoc(bytes: ByteArray, name: String): Int {
        val url = AIS_BASE + "/aisearch/v2/api/upload/docUpload"
        val resp = try {
            multipartUpload(url, bytes, name, casHeaders("POST", url, "https://i-search.csdn.net/"))
        } catch (e: Exception) {
            throw Exception("上传失败（400102000 多为图片含二维码/推广内容，裁剪后重试）: " + (e.message ?: "").slice(0 until minOf(100, (e.message ?: "").length)))
        }
        val data = resp.optJSONObject("data") ?: throw Exception("上传失败: " + resp.toString().slice(0 until minOf(120, resp.toString().length)))
        return data.optInt("id")
    }

    /** 文档上传：phoenix 通道 → 返回签名 URL（file_url），智能体文档分析用 */
    fun phoenixUpload(bytes: ByteArray, name: String): String {
        val resp = multipartUpload(PHOENIX_UPLOAD, bytes, name, oldHeaders("POST", PHOENIX_UPLOAD, "https://app-blog.csdn.net/"))
        val data = resp.optJSONObject("data") ?: throw Exception("上传失败: " + resp.toString().slice(0 until minOf(120, resp.toString().length)))
        return data.optString("url")
    }

    private fun casHeaders(method: String, url: String, referer: String): MutableMap<String, String> =
        Signer.casHeaders(method, url, "multipart/form-data", referer).apply {
            put("X-Ca-Signed-Content-Type", "multipart/form-data")
        }

    private fun oldHeaders(method: String, url: String, referer: String): MutableMap<String, String> =
        Signer.oldHeaders(method, url, "multipart/form-data", referer).apply {
            put("X-Ca-Signed-Content-Type", "multipart/form-data")
        }

    private fun multipartUpload(url: String, bytes: ByteArray, name: String, baseHeaders: MutableMap<String, String>): JSONObject {
        val boundary = "----csdnForm" + System.currentTimeMillis()
        val pre = ("--$boundary\r\nContent-Disposition: form-data; name=\"docFile\"; filename=\"$name\"\r\nContent-Type: application/octet-stream\r\n\r\n").toByteArray()
        val mid = "\r\n--$boundary\r\nContent-Disposition: form-data; name=\"upload_type\"\r\n\r\n\r\n".toByteArray()
        val end = "--$boundary--\r\n".toByteArray()
        val body = pre + bytes + mid + end
        val h = baseHeaders.toMutableMap()
        // 签名用字面量 multipart/form-data，但实际请求必须带 boundary，否则服务端解析失败（应用服务内部异常）
        h["Content-Type"] = "multipart/form-data; boundary=$boundary"
        val c = open("POST", url, h, body, 60000)
        return JSONObject(c.inputStream.bufferedReader().readText())
    }
}
