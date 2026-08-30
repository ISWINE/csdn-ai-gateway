package com.csdn.aug

import org.json.JSONArray
import org.json.JSONObject

/**
 * MCP「全模态解析」服务端（与 PC web-ui/lib/mcp-core.js 对齐）。
 * 传输：streamable HTTP（POST /mcp，无状态，单请求单响应）。
 * 与 PC 的差异：手机读不到客户端电脑的本地路径，parse_file/analyze_image 支持 data_b64 直传内容。
 */
object McpServer {
    private val SERVER_INFO = JSONObject().put("name", "csdn-aggregate").put("version", "1.1.0")
    private const val MAX_BYTES = 8 * 1024 * 1024
    private val INLINE_TEXT_EXT = listOf("md", "txt", "json", "csv", "html", "log", "yml", "yaml")

    fun dispatch(msg: JSONObject): JSONObject? {
        if (msg.optString("jsonrpc") != "2.0") return null
        val method = msg.optString("method")
        if (method.isEmpty()) return null
        val id = msg.opt("id")
        val params = msg.optJSONObject("params") ?: JSONObject()
        return try {
            when (method) {
                "initialize" -> result(id, JSONObject()
                    .put("protocolVersion", params.optString("protocolVersion", "2024-11-05"))
                    .put("capabilities", JSONObject().put("tools", JSONObject()))
                    .put("serverInfo", SERVER_INFO))
                "notifications/initialized" -> null
                "ping" -> result(id, JSONObject())
                "tools/list" -> result(id, JSONObject().put("tools", tools()))
                "tools/call" -> {
                    val name = params.optString("name")
                    val args = params.optJSONObject("arguments") ?: JSONObject()
                    try {
                        val text = callTool(name, args)
                        result(id, JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", text))).put("isError", false))
                    } catch (e: Exception) {
                        val m = (e.message ?: e.toString())
                        result(id, JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "错误: " + m.slice(0 until minOf(300, m.length))))).put("isError", true))
                    }
                }
                "resources/list" -> result(id, JSONObject().put("resources", JSONArray()))
                "prompts/list" -> result(id, JSONObject().put("prompts", JSONArray()))
                else -> if (id != null) err(id, -32601, "method not found: " + method) else null
            }
        } catch (e: Exception) {
            if (id != null) err(id, -32603, (e.message ?: e.toString()).slice(0 until minOf(300, (e.message ?: "").length + 20))) else null
        }
    }

    private fun result(id: Any?, r: JSONObject) = JSONObject().put("jsonrpc", "2.0").put("id", id ?: JSONObject.NULL).put("result", r)
    private fun err(id: Any?, code: Int, message: String) = JSONObject().put("jsonrpc", "2.0").put("id", id ?: JSONObject.NULL).put("error", JSONObject().put("code", code).put("message", message))

    private fun toolSchema(vararg props: Pair<String, JSONObject>): JSONObject {
        val o = JSONObject()
        for ((k, v) in props) o.put(k, v)
        return JSONObject().put("type", "object").put("properties", o)
    }

    private fun tools(): JSONArray {
        val str = { desc: String -> JSONObject().put("type", "string").put("description", desc) }
        val fileProps = arrayOf(
            Pair("path", str("文件的绝对路径（安卓服务器读不到你电脑的磁盘，推荐改传 data_b64）")),
            Pair("data_b64", str("文件内容的 base64（安卓端推荐方式）")),
            Pair("name", str("文件名（用 data_b64 时建议提供，带扩展名）")),
        )
        return JSONArray()
            .put(JSONObject()
                .put("name", "parse_file")
                .put("description", "聚合解析：上传文件（文本/图片/PDF/Word 等）到 CSDN 并用 DeepSeek-V4 Flash 解析，回答针对文件内容的问题。适合大文件、二进制文档、图片。")
                .put("inputSchema", toolSchema(*fileProps, Pair("question", str("想问文件内容的问题")))))
            .put(JSONObject()
                .put("name", "analyze_image")
                .put("description", "图片分析：上传图片并用 V4 Flash 视觉模型回答问题（截图内容识别、图表读数等）。")
                .put("inputSchema", toolSchema(*fileProps, Pair("question", str("关于图片的问题")))))
            .put(JSONObject()
                .put("name", "csdn_search")
                .put("description", "CSDN AI 搜索：站内博客检索 + 可选联网，返回带引用来源的回答。查技术资料/时效性信息时用。联网默认值跟随设置面板的「API 全局联网」开关。")
                .put("inputSchema", toolSchema(Pair("query", str("搜索问题")), Pair("web_search", JSONObject().put("type", "boolean").put("description", "是否联网检索（不传则跟随 API 全局联网开关）")))))
            .put(JSONObject()
                .put("name", "fast_chat")
                .put("description", "快聊问答（无工具、联网跟随 API 全局开关）。可选模型：csdn-v3-0324/csdn-qwen3-32b/csdn-qwen3-32b-think/csdn-qwen-plus/csdn-v4-flash，默认 csdn-v3-0324。")
                .put("inputSchema", toolSchema(Pair("query", str("问题")), Pair("model", str("csdn-v3-0324/csdn-qwen3-32b/csdn-qwen3-32b-think/csdn-qwen-plus/csdn-v4-flash，默认 csdn-v3-0324")))))
    }

    /** 取附件字节：data_b64 优先，其次尝试手机本地 path */
    private fun resolveBytes(args: JSONObject): Pair<ByteArray, String> {
        val b64 = args.optString("data_b64", "")
        if (b64.isNotEmpty()) {
            val bytes = try { android.util.Base64.decode(b64, android.util.Base64.DEFAULT) } catch (e: Exception) { ByteArray(0) }
            if (bytes.isEmpty()) throw Exception("data_b64 不是有效的 base64")
            val name = args.optString("name", "").ifEmpty { "upload.bin" }
            return Pair(bytes, name.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
        }
        val path = args.optString("path", "")
        if (path.isNotEmpty()) {
            val f = java.io.File(path.trim())
            if (!f.exists()) throw Exception("手机上不存在该路径（安卓服务器读不到你电脑的磁盘）：请改用 data_b64 传文件内容")
            return Pair(f.readBytes(), f.name)
        }
        throw Exception("path 与 data_b64 至少提供一个（安卓端推荐 data_b64）")
    }

    private fun difyAsk(query: String, docIds: String, webSearch: String, modelId: String): Pair<String, JSONArray> {
        val lock = Any()
        var answer = ""
        var errored: String? = null
        val refs = JSONArray()
        CsdnChannels.searchStream(query, webSearch, modelId, false, docIds, "", { kind, data ->
            synchronized(lock) {
                when (kind) {
                    "answer" -> answer += data
                    "refs" -> try { refs.put(JSONArray(data)) } catch (e: Exception) {}
                    "error" -> errored = data
                }
            }
        }, { })
        if (answer.isEmpty() && errored != null) throw Exception("上游错误: " + errored)
        return Pair(answer.trim(), refs)
    }

    private fun refLines(refs: JSONArray): String {
        val lines = mutableListOf<String>()
        for (i in 0 until refs.length()) {
            val arr = refs.optJSONArray(i) ?: continue
            for (j in 0 until arr.length()) {
                val r = arr.optJSONObject(j) ?: continue
                lines.add("- " + r.optString("title") + " " + r.optString("url"))
            }
        }
        return if (lines.isEmpty()) "" else "\n\n参考来源：\n" + lines.joinToString("\n")
    }

    private fun callTool(name: String, args: JSONObject): String {
        when (name) {
            "parse_file", "analyze_image" -> {
                val (bytes, fname) = resolveBytes(args)
                if (bytes.size > MAX_BYTES) throw Exception("文件超过 8MB 上传上限")
                val question = args.optString("question", "").ifEmpty { if (name == "analyze_image") "描述这张图片。" else "总结这个文件的内容。" }
                if (name == "parse_file") {
                    val ext = (fname.substringAfterLast('.', "").lowercase())
                    if (INLINE_TEXT_EXT.contains(ext) && bytes.size <= 30000) {
                        val (a, _) = difyAsk("[文件「$fname」内容]\n" + String(bytes, Charsets.UTF_8) + "\n[结束]\n\n$question", "", "0", "3")
                        return a
                    }
                }
                val docId = CsdnChannels.uploadDoc(bytes, fname)
                val (a, _) = difyAsk(question, docId.toString(), "0", "3")
                return a
            }
            "csdn_search" -> {
                val apiDefault = Registry.webSearchGlobals().second
                val ws = if (args.has("web_search")) (if (args.optBoolean("web_search")) "1" else "0") else (if (apiDefault) "1" else "0")
                val (a, refs) = difyAsk(args.optString("query", ""), "", ws, "1")
                return a + refLines(refs)
            }
            "fast_chat" -> {
                val model = args.optString("model", "csdn-v3-0324")
                if (!Registry.isModelEnabled(model)) throw Exception("模型「" + model + "」已在设置面板停用")
                val modelId = CsdnChannels.DIFY_SET[model] ?: throw Exception("fast_chat 仅支持 Dify 快模型: " + CsdnChannels.DIFY_SET.keys.joinToString("/"))
                val apiDefault = Registry.webSearchGlobals().second
                val (a, _) = difyAsk(args.optString("query", ""), "", if (apiDefault) "1" else "0", modelId)
                return a
            }
            else -> throw Exception("未知工具: " + name)
        }
    }
}
