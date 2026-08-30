/**
 * 网络版桥（部署在 Back4app）：公网门面 + 反向隧道服务端
 *
 * 数据面：外部客户端 → 本桥（HTTPS 公网 URL）→ [agent 长连接隧道] → 家里 csdn-ai-server → CSDN
 * CSDN 始终看到家用 IP（cookie 本就是该 IP 签发，规避机房 IP 风控）；cookie 不上云，本桥零敏感信息。
 *
 * 通道：
 *   GET  /bridge/agent    agent 的 SSE 下行：派活 {id,method,url,headers,body}；abort 通知 {id,t:"abort"}；
 *                         每 15s 发 ": ping" 注释行，防中间代理掐空闲连接
 *   POST /bridge/res/:id  agent 回传帧（JSON 信封）：{t:"head",status,headers} → {t:"chunk",b64}* → {t:"done"} | {t:"err",message}
 *   GET  /health          本桥自答（不依赖 agent），供 Back4app 健康检查与 agent 保活 ping，附 agent 在线状态
 *   其余路径              原样派给 agent（路径无关：网关以后加接口，桥零改动）
 *
 * 鉴权：BRIDGE_TOKEN 一密两用 —— agent 通道用 x-bridge-token 头；公网面用 Authorization: Bearer <BRIDGE_TOKEN>
 *
 * 启动： node bridge-server.js [端口，默认读 PORT 环境变量再退 8080] [BRIDGE_TOKEN，默认读同名环境变量]
 */
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8080;
const BRIDGE_TOKEN = process.argv[3] || process.env.BRIDGE_TOKEN || "";
const PING_INTERVAL = 15000;

let agentRes = null;        // 当前 agent SSE 连接（新连接顶掉旧连接）
let agentPing = null;
const pending = new Map();  // 派活 id -> { res, sentHead }

function log(...a) { console.log("[bridge]", ...a); }

function checkToken(req, res) {
  if (!BRIDGE_TOKEN || req.headers["x-bridge-token"] === BRIDGE_TOKEN) return true;
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end('{"error":{"message":"bad bridge token"}}');
  return false;
}

function agentSend(obj) {
  if (!agentRes) return false;
  try { agentRes.write(`data: ${JSON.stringify(obj)}\n\n`); return true; }
  catch { return false; }
}

function failPending(p, code, message) {
  if (p.sentHead) { p.res.end(); return; }
  p.sentHead = true;
  p.res.writeHead(code, { "Content-Type": "application/json" });
  p.res.end(JSON.stringify({ error: { message } }));
}

// 只拦逐跳头：host/content-length 由重新发起时自动算，accept-encoding 掐掉防止压缩体混进 b64 通道
const REQ_HEADER_DROP = new Set(["host", "connection", "content-length", "accept-encoding", "keep-alive"]);

function handlePublic(req, res) {
  if (BRIDGE_TOKEN) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${BRIDGE_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key（应为 BRIDGE_TOKEN）" } }));
      return;
    }
  }
  const id = crypto.randomUUID();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const p = { res, sentHead: false };
    pending.set(id, p);
    const ok = agentSend({
      id, method: req.method, url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !REQ_HEADER_DROP.has(k))),
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (!ok) {
      pending.delete(id);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "agent offline：本地 agent 未连接（家里 agent.js 没跑？）" } }));
      return;
    }
    log("派活", req.method, req.url, "在途=" + pending.size);
  });
  res.on("close", () => {   // 客户端中途断开：通知 agent 掐掉本地上游，省 CSDN 配额
    if (!pending.has(id)) return;
    pending.delete(id);
    agentSend({ id, t: "abort" });
  });
}

function handleAgent(req, res) {
  if (!checkToken(req, res)) return;
  if (agentRes) { try { agentRes.end(); } catch {} }   // 旧连接让位
  agentRes = res;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  log("agent 已连接");
  agentPing = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, PING_INTERVAL);
  res.on("close", () => {
    clearInterval(agentPing);
    if (agentRes === res) agentRes = null;
    for (const p of pending.values()) failPending(p, 503, "agent disconnected");
    pending.clear();
    log("agent 断开，在途请求已全部 503");
  });
}

function handleResult(req, res, id) {
  if (!checkToken(req, res)) return;
  const p = pending.get(id);
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (!p) { res.writeHead(410, { "Content-Type": "text/plain" }); res.end("gone"); return; }
    let ev;
    try { ev = JSON.parse(raw); } catch { pending.delete(id); failPending(p, 502, "bad agent frame"); return; }
    if (ev.t === "head") {
      p.sentHead = true;
      p.res.writeHead(ev.status || 200, ev.headers || {});
    } else if (ev.t === "chunk") {
      if (!p.sentHead) { p.sentHead = true; p.res.writeHead(200, { "Content-Type": "application/octet-stream" }); }
      p.res.write(Buffer.from(ev.b64 || "", "base64"));
    } else if (ev.t === "done") {
      pending.delete(id);
      p.res.end();
    } else if (ev.t === "err") {
      pending.delete(id);
      failPending(p, 502, ev.message || "upstream error");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://bridge");
  if (pathname === "/bridge/agent") return handleAgent(req, res);
  if (pathname.startsWith("/bridge/res/")) return handleResult(req, res, pathname.slice("/bridge/res/".length));
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, agent: !!agentRes, pending: pending.size }));
  }
  return handlePublic(req, res);
});

server.listen(PORT, () => {
  log("桥已启动 :", PORT);
  if (!BRIDGE_TOKEN) log("⚠️ 未设 BRIDGE_TOKEN：agent 通道与公网面均无鉴权，公网部署必须设置！");
});
