package com.csdn.aug

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URLDecoder

/** 极简 HTTP 请求（完整读取 body，规避 NanoHTTPD 的 body 丢失缺陷） */
class HttpReq(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val bodyBytes: ByteArray,
) {
    fun q(name: String): String? = query[name]
    fun bodyJson(): JSONObject = try { JSONObject(String(bodyBytes, Charsets.UTF_8)) } catch (e: Exception) { JSONObject() }
}

class HttpResponse(
    val status: Int = 200,
    val contentType: String = "application/json; charset=utf-8",
    val body: ByteArray? = null,
    val stream: InputStream? = null,
    val extraHeaders: Map<String, String> = emptyMap(),
) {
    companion object {
        fun json(o: Any?): HttpResponse = HttpResponse(200, "application/json; charset=utf-8", o.toString().toByteArray())
        fun err(status: Int, msg: String): HttpResponse = HttpResponse(status, "application/json; charset=utf-8", JSONObject().put("error", msg).toString().toByteArray())
        fun text(status: Int, text: String): HttpResponse = HttpResponse(status, "text/plain; charset=utf-8", text.toByteArray())
        fun sse(stream: InputStream): HttpResponse = HttpResponse(200, "text/event-stream; charset=utf-8", null, stream, mapOf("Cache-Control" to "no-cache"))
        fun file(mime: String, bytes: ByteArray): HttpResponse = HttpResponse(200, mime, bytes)
    }
}

/** 多线程极简 HTTP 服务器：每个连接一个线程，Connection: close */
class RawHttpServer(private val port: Int, private val handler: (HttpReq) -> HttpResponse) {
    private var serverSocket: ServerSocket? = null
    @Volatile private var stopped = false

    fun start() {
        Thread {
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress(port))
                serverSocket = ss
                while (!stopped) {
                    val sock = try { ss.accept() } catch (e: Exception) { if (!stopped) Thread.sleep(200); continue }
                    Thread { handleConn(sock) }.start()
                }
            } catch (e: Exception) {
                android.util.Log.e("csdn-aug", "server: " + e.message)
            }
        }.start()
    }

    fun stop() { stopped = true; try { serverSocket?.close() } catch (e: Exception) {} }

    private fun handleConn(sock: java.net.Socket) {
        try {
            sock.soTimeout = 300000
            val ins = sock.getInputStream()
            val head = StringBuilder()
            while (true) {
                val b = ins.read(); if (b == -1) return
                head.append(b.toChar())
                if (head.endsWith("\r\n\r\n")) break
                if (head.length > 65536) return
            }
            val headLines = head.toString().split("\r\n")
            val reqLine = headLines[0].split(" ")
            if (reqLine.size < 2) return
            val method = reqLine[0]
            val rawUri = reqLine[1]
            val headers = HashMap<String, String>()
            for (i in 1 until headLines.size) {
                val idx = headLines[i].indexOf(":")
                if (idx > 0) headers[headLines[i].slice(0 until idx).trim().lowercase()] = headLines[i].slice(idx + 1 until headLines[i].length).trim()
            }
            val cl = headers["content-length"]?.toIntOrNull() ?: 0
            val body = ByteArray(cl); var off = 0
            while (off < cl) { val n = ins.read(body, off, cl - off); if (n <= 0) break; off += n }
            val q = LinkedHashMap<String, String>()
            val qIdx = rawUri.indexOf("?")
            if (qIdx >= 0) {
                for (pair in rawUri.slice(qIdx + 1 until rawUri.length).split("&")) {
                    val i = pair.indexOf("=")
                    val k = URLDecoder.decode(if (i > 0) pair.slice(0 until i) else pair, "UTF-8")
                    val v = if (i > 0) URLDecoder.decode(pair.slice(i + 1 until pair.length), "UTF-8") else ""
                    q[k] = v
                }
            }
            val path = URLDecoder.decode(if (qIdx >= 0) rawUri.slice(0 until qIdx) else rawUri, "UTF-8")
            val req = HttpReq(method, path, q, headers, body)
            val resp = try { handler(req) } catch (e: Exception) {
                android.util.Log.e("csdn-aug", "handler: " + e.message)
                HttpResponse.err(500, (e.message ?: "服务器错误"))
            }
            writeResponse(sock, resp)
        } catch (e: Exception) { try { sock.close() } catch (e2: Exception) {} }
        finally { try { sock.close() } catch (e2: Exception) {} }
    }

    private fun writeResponse(sock: java.net.Socket, resp: HttpResponse) {
        val out = sock.getOutputStream()
        val reason = mapOf(200 to "OK", 202 to "Accepted", 400 to "Bad Request", 403 to "Forbidden", 404 to "Not Found", 500 to "Internal Server Error", 503 to "Service Unavailable").get(resp.status) ?: "OK"
        out.write(("HTTP/1.1 " + resp.status + " " + reason + "\r\n").toByteArray())
        out.write(("Content-Type: " + resp.contentType + "\r\n").toByteArray())
        for ((k, v) in resp.extraHeaders) out.write((k + ": " + v + "\r\n").toByteArray())
        if (resp.stream != null) {
            out.write("Transfer-Encoding: chunked\r\n".toByteArray())
            out.write("Connection: close\r\n\r\n".toByteArray())
            val buf = ByteArray(4096)
            while (true) {
                val n = resp.stream.read(buf)
                if (n <= 0) break
                out.write((Integer.toHexString(n) + "\r\n").toByteArray())
                out.write(buf, 0, n)
                out.write("\r\n".toByteArray())
                out.flush()
            }
            out.write("0\r\n\r\n".toByteArray())
            out.flush()
            return
        }
        val bodyBytes = resp.body ?: ByteArray(0)
        out.write(("Content-Length: " + bodyBytes.size + "\r\n").toByteArray())
        out.write("Connection: close\r\n\r\n".toByteArray())
        out.write(bodyBytes)
        out.flush()
    }
}
