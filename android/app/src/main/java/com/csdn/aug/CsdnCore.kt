package com.csdn.aug

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** 应用内文件存储 */
object Store {
    lateinit var filesDir: File
    fun init(ctx: Context) { filesDir = ctx.filesDir }
    fun readText(name: String): String? = File(filesDir, name).takeIf { it.exists() }?.readText()
    fun writeText(name: String, s: String) { File(filesDir, name).writeText(s) }
}

/** CSDN cookie 池（filesDir/csdn-cookies.json，与桌面版同格式） */
object CookieJar {
    @Synchronized
    fun load(): JSONArray = try { JSONArray(Store.readText("csdn-cookies.json") ?: "[]") } catch (e: Exception) { JSONArray() }

    @Synchronized
    fun save(jar: JSONArray) = Store.writeText("csdn-cookies.json", jar.toString(2))

    /** 备份当前并写入新 jar（导入/扫码收割共用） */
    @Synchronized
    fun backupAndWrite(jar: JSONArray) {
        val f = File(Store.filesDir, "csdn-cookies.json")
        if (f.exists()) f.copyTo(File(Store.filesDir, "csdn-cookies.json.bak"), overwrite = true)
        save(jar)
    }

    @Synchronized
    fun logout() {
        val f = File(Store.filesDir, "csdn-cookies.json")
        if (f.exists()) f.copyTo(File(Store.filesDir, "csdn-cookies.json.bak"), overwrite = true)
        save(JSONArray())
    }

    /** 全量 cookie 拼成请求头 */
    @Synchronized
    fun header(): String {
        val jar = load()
        val m = LinkedHashMap<String, String>()
        for (i in 0 until jar.length()) {
            val c = jar.optJSONObject(i) ?: continue
            m[c.optString("name")] = c.optString("value")
        }
        return m.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    /** 登录状态摘要 */
    @Synchronized
    fun status(): JSONObject {
        val out = JSONObject()
        val f = File(Store.filesDir, "csdn-cookies.json")
        if (!f.exists()) { out.put("exists", false); out.put("count", 0); return out }
        val jar = load()
        val names = HashSet<String>()
        for (i in 0 until jar.length()) names.add(jar.optJSONObject(i)?.optString("name") ?: "")
        out.put("exists", true)
        out.put("count", jar.length())
        out.put("hasUserToken", names.contains("UserToken") || names.contains("UserInfo"))
        out.put("hasSession", names.contains("SESSION"))
        out.put("hasBot", names.any { it.startsWith("bc_bot_") || it.startsWith("waf_") })
        out.put("mtime", f.lastModified())
        return out
    }

    /** 导入：支持 cookie 编辑器 JSON 数组 或 name=value; 头格式 */
    @Synchronized
    fun import(text: String): Pair<Int, Boolean> {
        val text = text.trim()
        var jar = JSONArray()
        try {
            val j = JSONArray(text)
            jar = JSONArray()
            for (i in 0 until j.length()) {
                val c = j.optJSONObject(i) ?: continue
                if (c.optString("name").isEmpty()) continue
                c.put("domain", c.optString("domain", ".csdn.net"))
                c.put("path", c.optString("path", "/"))
                jar.put(c)
            }
        } catch (e: Exception) {
            val clean = text.replace(Regex("^\\s*cookie\\s*:\\s*", RegexOption.IGNORE_CASE), "")
            for (pair in clean.split(";")) {
                val i = pair.indexOf("=")
                if (i < 1) continue
                val c = JSONObject()
                c.put("domain", ".csdn.net"); c.put("path", "/")
                c.put("name", pair.slice(0 until i).trim())
                c.put("value", pair.slice(i + 1 until pair.length).trim())
                jar.put(c)
            }
        }
        if (jar.length() == 0) throw Exception("未能解析出任何 cookie")
        val names = HashSet<String>()
        for (i in 0 until jar.length()) names.add(jar.optJSONObject(i)?.optString("name") ?: "")
        val hasToken = names.contains("UserToken") || names.contains("UserInfo")
        backupAndWrite(jar)
        return Pair(jar.length(), hasToken)
    }
}

/** 双密钥签名 + URL 三明治 sign（移植 web-ui/lib/signer.js，见 REPORT.md 第八章） */
object Signer {
    const val OLD_KEY = "203803574"
    const val OLD_SECRET = "9znpamsyl2c7cdrr9sas0le9vbc3r6ba"
    const val CAS_KEY = "280526253"
    const val CAS_SECRET = "673BzMJHuGF8vQBfRyWpTrXwq5rSgRGD"

    fun nonce(): String = UUID.randomUUID().toString()
    fun md5Hex(s: String): String = MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
    fun b64(s: String): String = Base64.getEncoder().encodeToString(s.toByteArray(Charsets.UTF_8))
    fun hmac(key: String, secret: String, data: String): String =
        Base64.getEncoder().encodeToString(Mac.getInstance(key).apply {
            init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), key))
        }.doFinal(data.toByteArray(Charsets.UTF_8)))

    private fun baseHeaders(referer: String): MutableMap<String, String> = mutableMapOf(
        "Accept" to "*/*",
        "Referer" to referer,
        "User-Agent" to "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
        "Cookie" to CookieJar.header(),
    )

    /** 老密钥（ai-middle / phoenix / aisearch session）：uid 必带头 */
    fun oldHeaders(method: String, url: String, ct: String, referer: String): MutableMap<String, String> {
        val p = java.net.URL(url).path
        val n = nonce()
        val sts = listOf(method.uppercase(), "*/*", "", ct, "", "x-ca-key:$OLD_KEY", "x-ca-nonce:$n", p).joinToString("\n")
        return mutableMapOf(
            "Content-Type" to ct,
            "uid" to Registry.uid(),
            "x-ca-key" to OLD_KEY,
            "x-ca-nonce" to n,
            "x-ca-timestamp" to System.currentTimeMillis().toString(),
            "x-ca-signature-headers" to "x-ca-key,x-ca-nonce",
            "x-ca-signature" to hmac("HmacSHA256", OLD_SECRET, sts),
        ).apply { putAll(baseHeaders(referer)) }
    }

    /** cas 密钥（aisearch Dify）：四头 StringToSign + path?排序query（sign 参数参与） */
    fun casHeaders(method: String, url: String, ct: String, referer: String): MutableMap<String, String> {
        val u = java.net.URL(url)
        val params = LinkedHashMap<String, String>()
        u.query?.split("&")?.forEach { p ->
            val i = p.indexOf("=")
            if (i > 0) params[p.slice(0 until i)] = java.net.URLDecoder.decode(p.slice(i + 1 until p.length), "UTF-8")
            else params[p] = ""
        }
        val ts = System.currentTimeMillis().toString(); val n = nonce()
        val sigHeadersVal = "x-ca-key,x-ca-nonce,x-ca-signature-headers,x-ca-timestamp"
        val stsHeads = sortedMapOf(
            "x-ca-key" to CAS_KEY, "x-ca-nonce" to n,
            "x-ca-signature-headers" to sigHeadersVal, "x-ca-timestamp" to ts,
        )
        var sts = "${method.uppercase()}\n*/*\n\n$ct\n\n"
        for ((k, v) in stsHeads) sts += "$k:$v\n"
        val qs = params.keys.sorted()
        sts += if (qs.isNotEmpty()) u.path + "?" + qs.joinToString("&") { k -> if (params[k] != "") "$k=${params[k]}" else k } else u.path
        val sig = hmac("HmacSHA256", CAS_SECRET, sts)
        return mutableMapOf(
            "Content-Type" to ct,
            "X-Ca-Key" to CAS_KEY, "X-Ca-Nonce" to n, "X-Ca-Signature-Headers" to sigHeadersVal,
            "X-Ca-Timestamp" to ts, "X-Ca-Signature" to sig,
        ).apply { putAll(baseHeaders(referer)) }
    }

    /** URL 三明治：MD5("[#" + MD5(Base64(非空字段按序 kv)) + "#]") */
    fun qsSign(obj: JSONObject, fields: List<String>): String {
        val kv = mutableListOf<String>()
        for (f in fields) {
            val v = obj.optString(f, "")
            if (v.isNotEmpty()) kv.add("$f=${v.trim()}")
        }
        return md5Hex("[#${md5Hex(b64(kv.joinToString("&")))}#]")
    }
}

/** 模型注册表 + 开关（filesDir/config.json 热读取） */
object Registry {
    // id -> (label, group)
    val ALL_MODELS = linkedMapOf(
        "deepseek-chat" to Pair("DeepSeek-V3 · 思考（ai-middle，带工具/编码主力）", "对话"),
        "deepseek-reasoner" to Pair("DeepSeek-R1 · 深思考（ai-middle，带工具）", "对话"),
        "csdn-agent-flash" to Pair("Agent Flash（phoenix，V4，多轮/文档）", "智能体"),
        "csdn-agent-pro" to Pair("Agent Pro（phoenix，V4 Pro）", "智能体"),
        "csdn-v3-0324" to Pair("DeepSeek-V3-0324（Dify，最快）", "快聊"),
        "csdn-qwen3-32b" to Pair("Qwen3-32B（Dify，快）", "快聊"),
        "csdn-qwen3-32b-think" to Pair("Qwen3-32B-Thinking（Dify，推理）", "快聊"),
        "csdn-qwen-plus" to Pair("Qwen-PLUS（Dify，快）", "快聊"),
        "csdn-v4-flash" to Pair("DeepSeek-V4-Flash（Dify，视觉/文档解析）", "快聊"),
    )
    private fun cfg(): JSONObject = try { JSONObject(Store.readText("config.json") ?: "{}") } catch (e: Exception) { JSONObject() }
    fun isModelEnabled(id: String): Boolean {
        if (!ALL_MODELS.containsKey(id)) return false
        val m = cfg().optJSONObject("models") ?: return true
        val v = m.opt(id) ?: return true
        return v == true
    }
    fun switches(): JSONObject {
        val out = JSONObject()
        for (id in ALL_MODELS.keys) out.put(id, isModelEnabled(id))
        return out
    }
    fun registryJson(): JSONObject {
        val out = JSONObject()
        for ((id, info) in ALL_MODELS) out.put(id, JSONObject().put("label", info.first).put("group", info.second))
        return out
    }
    fun setSwitches(models: JSONObject) {
        val cfg = cfg(); val clean = JSONObject()
        for (id in ALL_MODELS.keys) if (models.has(id)) clean.put(id, models.optBoolean(id))
        cfg.put("models", clean)
        Store.writeText("config.json", cfg.toString(2))
    }
    fun webSearchGlobals(): Pair<Boolean, Boolean> {
        val ws = cfg().optJSONObject("webSearch") ?: return Pair(true, false)
        return Pair(ws.optBoolean("web", true), ws.optBoolean("api", false))
    }
    fun setWebSearchGlobals(web: Boolean, api: Boolean) {
        val cfg = cfg(); cfg.put("webSearch", JSONObject().put("web", web).put("api", api))
        Store.writeText("config.json", cfg.toString(2))
    }
    fun uid(): String {
        val fromCfg = cfg().optString("uid", "")
        if (fromCfg.isNotEmpty()) return fromCfg
        // 登录 cookie 里就有用户名（UserName/UN），自动读取零配置
        return try {
            val jar = CookieJar.load()
            var found = ""
            for (i in 0 until jar.length()) {
                val c = jar.optJSONObject(i) ?: continue
                val n = c.optString("name")
                val v = c.optString("value")
                if (v.isNotEmpty() && (n == "UserName" || n == "UN")) found = v
            }
            found
        } catch (e: Exception) { "" }
    }
    fun setUid(v: String) {
        val cfg = cfg(); cfg.put("uid", v)
        Store.writeText("config.json", cfg.toString(2))
    }
    fun isMcpEnabled(): Boolean = cfg().optBoolean("mcpEnabled", true)
    fun setMcpEnabled(on: Boolean) {
        val cfg = cfg(); cfg.put("mcpEnabled", on)
        Store.writeText("config.json", cfg.toString(2))
    }
}
