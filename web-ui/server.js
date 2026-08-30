/**
 * CSDN 增强版 Web UI 服务：静态托管 + 三通道 SSE 直通代理（服务端零缓冲）
 * 零第三方依赖（node 原生 http）。启动：node server.js [端口，默认 3010]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const channels = require("./lib/channels");
const registry = require("./lib/models-registry");
const mcpCore = require("./lib/mcp-core");
const direct = require("../csdn_ai_direct");
const { spawn } = require("child_process");

const APP_VERSION = "v2026.08.30";

const ROOT_DIR = path.join(__dirname, "..");
const COOKIE_FILE = path.join(ROOT_DIR, "csdn-cookies.json");
const COOKIE_BAK = COOKIE_FILE + ".bak";
// 扫码登录子进程状态（login.js Playwright 流程）
const qrState = { running: false, lines: [], success: false, startedAt: null };

/* --- 网页内嵌扫码登录（无头浏览器加载官方登录页，微信扫码，无需本机弹窗） --- */
let qr2 = null; // { running, status: loading|qr|success|error, img(dataURL), err, ctx, startedAt, timer }
const QR2_PROFILE = path.join(ROOT_DIR, "login_profile_web");

function qr2Harvest(ctx, page) {
  return (async () => {
    try { await page.goto("https://editor.csdn.net/md/", { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2500); } catch {}
    const all = await ctx.cookies();
    const csdn = all.filter((c) => (c.domain || "").includes("csdn.net"));
    const out = csdn.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/", secure: !!c.secure, httpOnly: !!c.httpOnly, ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}) }));
    try { if (fs.existsSync(COOKIE_FILE)) fs.copyFileSync(COOKIE_FILE, COOKIE_BAK); } catch {}
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(out, null, 2));
    console.log("[qr2] 登录成功，已采集", out.length, "个 cookie（原文件已备份）");
  })();
}

async function qr2Start() {
  if (qr2 && qr2.running) return { running: true };
  qr2 = { running: true, status: "loading", img: null, err: null, startedAt: Date.now(), ctx: null, timer: null };
  (async () => {
    let page = null;
    try {
      const { chromium } = require("playwright");
      const ctx = await chromium.launchPersistentContext(QR2_PROFILE, {
        headless: true, viewport: { width: 560, height: 800 },
        args: ["--disable-blink-features=AutomationControlled"],
      });
      qr2.ctx = ctx;
      page = await ctx.newPage();
      await page.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true }); });
      await page.goto("https://passport.csdn.net/account/login", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(4000);
      // profile 留有会话？cookie 存在 ≠ 有效——验证 editor 页不跳登录页才算已登录，避免把过期会话收割覆盖好 jar
      let core = (await ctx.cookies()).filter((c) => ["UserToken", "UserInfo", "SESSION", "UserNick"].includes(c.name));
      let verified = false;
      if (core.length >= 2) {
        try {
          await page.goto("https://editor.csdn.net/md/", { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(3500);
          verified = /editor\.csdn\.net/.test(page.url());
        } catch {}
      }
      if (verified) {
        await qr2Harvest(ctx, page);   // 先收割落盘再置 success，前端立即刷新状态才能读到
        qr2.status = "success";
        qr2.running = false;
        try { await ctx.close(); } catch {}
        return;
      }
      // 会话无效/无会话 → 回登录页提取二维码
      if (page.url().indexOf("passport.csdn.net") === -1) {
        await page.goto("https://passport.csdn.net/account/login", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(4000);
      }
      // 提取二维码 dataURL（180x180 的 data:image）
      const dataUrl = await page.evaluate(() => {
        for (const im of document.images) {
          const r = im.getBoundingClientRect();
          if ((im.src || "").startsWith("data:image") && r.width >= 120 && r.width <= 300) return im.src;
        }
        return null;
      });
      if (!dataUrl) { qr2.status = "error"; qr2.err = "页面上未找到二维码（页面结构可能变化）"; qr2.running = false; try { await ctx.close(); } catch {} return; }
      qr2.status = "qr"; qr2.img = dataUrl;
      // 轮询登录态，最长 5 分钟
      qr2.timer = setInterval(async () => {
        try {
          if (!qr2 || !qr2.running) return clearInterval(qr2.timer);
          const cs = await ctx.cookies();
          const core2 = cs.filter((c) => ["UserToken", "UserInfo", "SESSION", "UserNick"].includes(c.name));
          if (core2.length >= 2) {
            clearInterval(qr2.timer);
            await qr2Harvest(ctx, page);   // 先收割落盘再置 success
            qr2.status = "success";
            qr2.running = false;
            try { await ctx.close(); } catch {}
          } else if (Date.now() - qr2.startedAt > 300000) {
            clearInterval(qr2.timer);
            qr2.status = "expired"; qr2.err = "二维码已超时，请重新获取";
            qr2.running = false;
            try { await ctx.close(); } catch {}
          }
        } catch {}
      }, 2000);
    } catch (e) {
      qr2.status = "error"; qr2.err = String(e.message || e).slice(0, 200); qr2.running = false;
      try { if (qr2.ctx) await qr2.ctx.close(); } catch {}
    }
  })();
  return { started: true };
}

const PORT = Number(process.argv[2]) || 3010;
const ROOT = __dirname;
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const sseClients = new Map(); // legacy SSE 传输：clientId → res
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/* ---------- 会话历史（本地 JSON 持久化） ---------- */
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return { sessions: [] }; }
}
function saveHistory(db) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(db, null, 1));
  return db;
}

/* ---------- 工具 ---------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
function readBody(req, limit = 9 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function startSSE(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(":ok\n\n");
  const send = (obj) => { try { res.write(`data:${JSON.stringify(obj)}\n\n`); } catch {} };
  return send;
}
function serveStatic(res, urlPath) {
  let p = urlPath === "/" ? "/index.html" : urlPath;
  const abs = path.join(ROOT, "public", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!abs.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------- CSDN 反向代理 ---------- */
// 注入到代理 HTML 的同源化脚本：把页面里的 API 调用（csdn.net 域）重写回本代理
const PROXY_INJECT = `<script>(function(){
  function R(u){
    try{
      if(typeof u!=="string")return u;
      if(u.indexOf("/cdn-proxy/")===0)return u;
      var m=u.match(/^https?:\\/\\/([^\\/]+)(\\/[\\s\\S]*)?$/);
      if(m&&/(^|\\.)csdn\\.net$/i.test(m[1]))return "/cdn-proxy/"+m[1]+(m[2]||"");
      if(u.charAt(0)==="/")return "/cdn-proxy/editor.csdn.net"+u;
      return u;
    }catch(e){return u;}
  }
  var of=window.fetch;
  if(of)window.fetch=function(input,init){try{
    if(typeof input==="string")input=R(input);
    else if(input&&input.url)input=new Request(R(input.url),input);
  }catch(e){}return of.call(this,input,init);};
  var oo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){try{u=R(u);}catch(e){}return oo.apply(this,[m,u].concat([].slice.call(arguments,2)));};
  var oe=window.EventSource;
  if(oe)window.EventSource=function(u,c){try{u=R(u);}catch(e){}return new oe(u,c);};
})();</script>`;

function jarCookieHeader(browserCookie) {
  const map = new Map();
  try {
    for (const c of JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"))) map.set(c.name, c.value);
  } catch {}
  if (browserCookie) for (const pair of browserCookie.split(";")) {
    const i = pair.indexOf("=");
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

async function proxyCSDN(req, res, host, tpath, query, inject) {
  const target = "https://" + host + tpath + (query || "");
  const headers = {};
  // 透传请求头（除 hop-by-hop 与需要重写的域头）
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (["host", "cookie", "origin", "referer", "accept-encoding", "connection", "content-length"].includes(lk)) continue;
    headers[k] = v;
  }
  headers.Referer = "https://editor.csdn.net/";
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") headers.Origin = "https://editor.csdn.net";
  headers.Cookie = jarCookieHeader(req.headers.cookie);
  let up;
  try {
    up = await fetch(target, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req),
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return sendJSON(res, 502, { error: "代理请求失败: " + String(e.message || e).slice(0, 120) });
  }
  // 响应头过滤 + Set-Cookie 重映射到本源
  const outHeaders = {};
  const setCookies = up.headers.getSetCookie ? up.headers.getSetCookie() : [];
  for (const [k, v] of up.headers.entries()) {
    const lk = k.toLowerCase();
    if (["content-encoding", "content-length", "transfer-encoding", "content-security-policy", "x-frame-options", "set-cookie"].includes(lk)) continue;
    outHeaders[k] = v;
  }
  if (setCookies.length) outHeaders["Set-Cookie"] = setCookies.map((sc) => sc
    .replace(/;\s*domain=[^;]+/gi, "")
    .replace(/;\s*secure/gi, "")
    .replace(/;\s*httponly/gi, "")
    .replace(/;\s*samesite=[^;]+/gi, "; SameSite=Lax"));
  const ct = (up.headers.get("content-type") || "");
  // HTML：缓冲并注入同源化脚本（仅 editor.csdn.net 页面）
  if (inject && ct.includes("text/html")) {
    const html = await up.text();
    const i = html.toLowerCase().indexOf("<head");
    const headEnd = i >= 0 ? html.indexOf(">", i) + 1 : 0;
    const out = headEnd ? html.slice(0, headEnd) + PROXY_INJECT + html.slice(headEnd) : PROXY_INJECT + html;
    res.writeHead(up.status, { ...outHeaders, "Content-Type": ct, "Content-Length": String(Buffer.byteLength(out)) });
    return res.end(out);
  }
  res.writeHead(up.status, { ...outHeaders, "Content-Type": ct || "application/octet-stream" });
  if (req.method === "HEAD" || !up.body) return res.end();
  // 其余流式直通
  const reader = up.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

/* ---------- 路由 ---------- */
const handler = async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if (p === "/api/health") return sendJSON(res, 200, { ok: true, ts: Date.now(), v: APP_VERSION });

    /* --- 一键诊断：cookie 数量 + ai-middle 原始连通性（安卓同名端点对齐） --- */
    if (p === "/api/dbg" && req.method === "GET") {
      const q = u.searchParams.get("q") || "你好";
      let cookieCount = -1;
      try { cookieCount = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")).length; } catch (e1) {}
      try {
        const r = await direct.askRawResponse(q);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let acc = "";
        while (acc.length < 600) { const c = await reader.read(); if (c.done) break; acc += dec.decode(c.value, { stream: true }); }
        try { await reader.cancel(); } catch (e2) {}
        return sendText(res, 200, "cookies=" + cookieCount + "\nstatus=" + r.status + "\n--- body 前600 ---\n" + acc.slice(0, 600));
      } catch (e) {
        return sendText(res, 200, "cookies=" + cookieCount + "\nstatus=FAIL " + (e.message || e));
      }
    }

    /* --- 模型列表 --- */
    if (p === "/api/models" && req.method === "GET") {
      const m = await channels.listModels();
      const sw = registry.modelSwitches();
      // aisearch 下拉按 gateway 开关过滤（id→gateway 名映射）
      if (Array.isArray(m.search)) {
        m.search = m.search.filter((x) => {
          const gw = registry.AISEARCH_TO_GATEWAY[String(x.id)];
          return gw ? sw[gw] !== false : true;
        });
        m.search = m.search.map((x) => ({ ...x, gw: registry.AISEARCH_TO_GATEWAY[String(x.id)] || null }));
      }
      m.registry = registry.ALL_MODELS;
      m.switches = sw;
      return sendJSON(res, 200, m);
    }

    /* --- 模型开关 + 联网全局 + MCP 开关（web 设置面板） --- */
    if (p === "/api/config" && req.method === "GET") {
      return sendJSON(res, 200, { models: registry.modelSwitches(), registry: registry.ALL_MODELS, webSearch: registry.getWebSearchGlobals(), mcpEnabled: registry.isMcpEnabled(), mcpCommand: "node", mcpArgs: [path.join(__dirname, "mcp-server.js")] });
    }
    if (p === "/api/config" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (body.models && typeof body.models === "object") {
        const cfg = registry.loadConfig();
        cfg.models = {};
        for (const [id, v] of Object.entries(body.models)) {
          if (registry.ALL_MODELS[id]) cfg.models[id] = !!v;
        }
        registry.saveConfig(cfg);
        console.log("[config] 模型开关已更新:", JSON.stringify(cfg.models));
      }
      if (body.webSearch && typeof body.webSearch === "object") {
        registry.setWebSearchGlobals(body.webSearch.web, body.webSearch.api);
        console.log("[config] 全局联网开关已更新:", JSON.stringify(registry.getWebSearchGlobals()));
      }
      if (body.mcpEnabled !== undefined) {
        const cfg = registry.loadConfig();
        cfg.mcp = { enabled: !!body.mcpEnabled };
        registry.saveConfig(cfg);
        console.log("[config] MCP 开关已更新:", cfg.mcp.enabled);
      }
      return sendJSON(res, 200, { ok: true, models: registry.modelSwitches(), webSearch: registry.getWebSearchGlobals(), mcpEnabled: registry.isMcpEnabled() });
    }

    /* --- 历史 --- */
    if (p === "/api/history" && req.method === "GET") {
      // 过滤空会话（历史遗留：刷新曾自动建空会话入库）
      const db = loadHistory();
      const live = db.sessions.filter((x) => x.messages && x.messages.length);
      if (live.length !== db.sessions.length) { db.sessions = live; saveHistory(db); }
      return sendJSON(res, 200, db);
    }
    if (p === "/api/history" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const db = loadHistory();
      const i = db.sessions.findIndex((s) => s.id === body.id);
      if (i >= 0) db.sessions[i] = body; else db.sessions.unshift(body);
      db.sessions = db.sessions.slice(0, 100);
      saveHistory(db);
      return sendJSON(res, 200, { ok: true });
    }
    if (p.startsWith("/api/history/") && req.method === "DELETE") {
      const id = p.slice("/api/history/".length);
      const db = loadHistory();
      db.sessions = db.sessions.filter((s) => s.id !== id);
      saveHistory(db);
      return sendJSON(res, 200, { ok: true });
    }

    /* --- 文档上传（raw body，文件名在 ?name=；target=search 走 AI搜索 docUpload，默认 agent 走 phoenix）--- */
    if (p === "/api/upload" && req.method === "POST") {
      const buf = await readBody(req);
      if (!buf.length) return sendJSON(res, 400, { error: "空文件" });
      const name = (u.searchParams.get("name") || "upload.md").replace(/[\\/:*?"<>|]/g, "_");
      const target = u.searchParams.get("target") || "agent";
      if (target === "search") {
        try {
          const r = await channels.uploadSearchDoc(buf, name);
          return sendJSON(res, 200, { docId: r.docId, fileName: r.fileName });
        } catch (e) {
          return sendJSON(res, 502, { error: String(e.message || e).slice(0, 200) });
        }
      }
      const tmp = path.join(os.tmpdir(), `webui-upload-${Date.now()}-${name}`);
      fs.writeFileSync(tmp, buf);
      try {
        const phoenix = require("../phoenix_agent");
        let r;
        try {
          r = await phoenix.uploadDoc(tmp);
        } catch (e1) {
          // 实测上游偶发限流/瞬时失败，2 秒后自动重试一次
          await new Promise((r2) => setTimeout(r2, 2000));
          r = await phoenix.uploadDoc(tmp);
        }
        try { fs.unlinkSync(tmp); } catch {}
        // 统一字段：前端与调用方读 file_url
        return sendJSON(res, 200, { file_url: r.url, fileName: r.fileName });
      } catch (e) {
        return sendJSON(res, 502, { error: String(e.message || e).slice(0, 200) });
      }
    }

    /* --- 三通道流式 --- */
    if (p === "/api/chat" || p === "/api/agent" || p === "/api/search") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const send = startSSE(res);
      const onEvent = (ev) => send(ev);
      const abort = () => { try { res.end(); } catch {} };
      req.on("close", abort);
      if (p === "/api/chat") await channels.chatStream({ message: body.message, history: body.history || [] }, onEvent);
      else if (p === "/api/agent") {
        // 智能体通道连空 → 兜底转 ai-middle 直答，保证必有输出
        let answerChars = 0;
        const wrapped = (ev) => { if (ev.t === "answer") answerChars += (ev.text || "").length; onEvent(ev); };
        await channels.agentStream({ messages: body.messages || [], model: body.model, fileUrl: body.fileUrl }, wrapped);
        if (answerChars === 0) {
          const lastUser = (body.messages || []).filter((m) => m.role === "user").pop();
          onEvent({ t: "answer", text: "（智能体通道无响应，已转直连通道）\n\n" });
          await channels.chatStream({ message: (lastUser && lastUser.content) || body.message || "", history: [] }, onEvent);
        }
      }
      else {
        // web 全局联网开关：关时无论前端开关如何都强制关
        const wsGlobal = registry.getWebSearchGlobals().web;
        const ws = wsGlobal ? (body.webSearch === "1" || body.webSearch === true ? "1" : "0") : "0";
        await channels.searchStream({ query: body.query, webSearch: ws, modelId: body.modelId, pure: body.pure, docIds: body.docIds || "", sid: body.sid || "" }, onEvent);
      }
      try { res.end(); } catch {}
      return;
    }

    /* --- MCP 传输端点：streamable HTTP + legacy SSE（逻辑同 stdio mcp-server） --- */
    if (p === "/mcp" && req.method === "POST") {
      // Streamable HTTP（无状态模式）：单请求单响应
      if (!registry.isMcpEnabled()) return sendJSON(res, 503, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "MCP 已在 web 设置面板停用" } });
      const msg = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const resp = await mcpCore.dispatch(msg);
      if (!resp) return sendJSON(res, 202, {});
      return sendJSON(res, 200, resp);
    }
    if (p === "/mcp/sse" && req.method === "GET") {
      // Legacy SSE 传输：先推 endpoint，后续 POST /mcp/messages 在此流上回消息
      const clientId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: endpoint\ndata: /mcp/messages?clientId=${clientId}\n\n`);
      sseClients.set(clientId, res);
      req.on("close", () => sseClients.delete(clientId));
      return;
    }
    if (p === "/mcp/messages" && req.method === "POST") {
      const clientId = u.searchParams.get("clientId");
      const client = sseClients.get(clientId);
      if (!client) return sendJSON(res, 404, { error: "unknown clientId" });
      let msg;
      try { msg = JSON.parse((await readBody(req)).toString("utf8")); } catch { return sendJSON(res, 400, { error: "bad json" }); }
      const resp = await mcpCore.dispatch(msg);
      if (resp) client.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
      return sendJSON(res, 202, {});
    }

    /* --- 登录 / Cookie 管理 --- */
    if (p === "/api/auth/status" && req.method === "GET") {
      let out = { exists: false, count: 0, hasUserToken: false, hasSession: false, hasBot: false, mtime: null };
      try {
        const st = fs.statSync(COOKIE_FILE);
        const jar = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
        const names = new Set((Array.isArray(jar) ? jar : []).map((c) => c.name));
        out = {
          exists: true, count: jar.length,
          hasUserToken: names.has("UserToken") || names.has("UserInfo"),
          hasSession: names.has("SESSION"),
          hasBot: [...names].some((n) => n.startsWith("bc_bot_") || n.startsWith("waf_")),
          mtime: st.mtimeMs,
        };
      } catch {}
      return sendJSON(res, 200, { ...out, qrRunning: qrState.running, qrLines: qrState.lines.slice(-6), qrSuccess: qrState.success });
    }
    if (p === "/api/auth/qr-login" && req.method === "POST") {
      if (qrState.running) return sendJSON(res, 200, { started: true, running: true, note: "扫码流程已在进行中" });
      qrState.running = true; qrState.lines = ["启动 Playwright 浏览器…"]; qrState.success = false; qrState.startedAt = Date.now();
      const child = spawn(process.execPath, [path.join(ROOT_DIR, "login.js")], { cwd: ROOT_DIR });
      child.stdout.on("data", (d) => {
        for (const l of String(d).split("\n")) if (l.trim()) qrState.lines.push(l.trim());
        if (qrState.lines.length > 50) qrState.lines = qrState.lines.slice(-50);
      });
      child.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (l.trim()) qrState.lines.push("[err] " + l.trim()); });
      child.on("close", (code) => {
        qrState.running = false;
        const ok = fs.existsSync(COOKIE_FILE) && (() => { try { const j = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")); return Array.isArray(j) && j.some((c) => c.name === "UserToken" || c.name === "UserInfo"); } catch { return false; } })();
        qrState.success = code === 0 && ok;
        qrState.lines.push(code === 0 ? (qrState.success ? "✓ 登录完成，cookie 已生效" : "进程结束但未检测到登录态") : "进程退出 code=" + code + (code === 2 ? "（超时未扫码）" : ""));
      });
      return sendJSON(res, 200, { started: true });
    }
    if (p === "/api/auth/import" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const text = String(body.text || "").trim();
      if (!text) return sendJSON(res, 400, { error: "内容为空" });
      let jar = null;
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j)) jar = j.filter((c) => c && c.name && typeof c.value !== "undefined").map((c) => ({ domain: c.domain || ".csdn.net", path: c.path || "/", ...c }));
      } catch {}
      if (!jar) {
        // Cookie 头字符串格式（兼容 "Cookie:" 前缀）
        const clean = text.replace(/^\s*cookie\s*:\s*/i, "");
        jar = clean.split(";").map((pair) => {
          const i = pair.indexOf("=");
          if (i < 1) return null;
          return { domain: ".csdn.net", path: "/", name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
        }).filter(Boolean);
      }
      if (!jar.length) return sendJSON(res, 400, { error: "未能解析出任何 cookie（支持 JSON 数组或 name=value; ... 头格式）" });
      try { if (fs.existsSync(COOKIE_FILE)) fs.copyFileSync(COOKIE_FILE, COOKIE_BAK); } catch {}
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(jar, null, 2));
      const names = new Set(jar.map((c) => c.name));
      console.log("[auth] cookie 导入:", jar.length + " 个（备份至 csdn-cookies.json.bak）");
      return sendJSON(res, 200, { ok: true, count: jar.length, hasUserToken: names.has("UserToken") || names.has("UserInfo"), warn: !(names.has("UserToken") || names.has("UserInfo")) ? "未检测到 UserToken/UserInfo——导入的可能不是登录态 cookie" : null });
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      try { if (fs.existsSync(COOKIE_FILE)) fs.copyFileSync(COOKIE_FILE, COOKIE_BAK); } catch {}
      fs.writeFileSync(COOKIE_FILE, "[]");
      // 附带清空登录持久化：扫码 profile / 本机登录 profile 里的会话一并删除，否则再点登录会直接回滚旧账号
      let cleared = 0;
      for (const dir of [path.join(ROOT_DIR, "login_profile_web"), path.join(ROOT_DIR, "login_profile")]) {
        try { if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); cleared++; } } catch {}
      }
      console.log("[auth] 已退出登录（cookie 备份至 .bak；扫码/本机登录 profile 已清除 " + cleared + " 个）");
      return sendJSON(res, 200, { ok: true, note: "已清空 cookie 与扫码/本机登录的持久化会话（原 cookie 备份至 .bak）" });
    }

    if (p === "/api/auth/export" && req.method === "GET") {
      const jar = fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, "utf8") : "[]";
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="csdn-cookies.json"',
      });
      return res.end(jar);
    }
    if (p === "/api/lan-info" && req.method === "GET") {
      let ip = null;
      const os = require("os");
      for (const nets of Object.values(os.networkInterfaces())) {
        for (const n of nets || []) {
          if (n.family === "IPv4" && !n.internal) { ip = n.address; break; }
        }
        if (ip) break;
      }
      return sendJSON(res, 200, { ip, port: PORT });
    }
    if (p === "/api/auth/qr2/start" && req.method === "POST") return sendJSON(res, 200, await qr2Start());
    if (p === "/api/auth/qr2/status" && req.method === "GET") {
      if (!qr2) return sendJSON(res, 200, { running: false, status: "idle" });
      return sendJSON(res, 200, { running: qr2.running, status: qr2.status, err: qr2.err, qr: qr2.status === "qr" ? qr2.img : null, waitSecs: Math.round((Date.now() - qr2.startedAt) / 1000) });
    }

    /* --- CSDN 反向代理（编辑器资源同源化：/cdn-proxy/<host>/<path>） --- */
    if (p.startsWith("/cdn-proxy/")) {
      const rest = p.slice("/cdn-proxy/".length);
      const host = rest.slice(0, rest.indexOf("/"));
      const tpath = rest.slice(rest.indexOf("/")) || "/";
      return proxyCSDN(req, res, host, tpath, u.search, true);
    }
    /* --- 编辑器入口：/editor-proxy/* → editor.csdn.net（HTML 注入同源化脚本） --- */
    if (p.startsWith("/editor-proxy/")) {
      return proxyCSDN(req, res, "editor.csdn.net", p.slice("/editor-proxy".length), u.search, true);
    }

    /* --- 静态（未命中且是 GET → 兜底代理到 editor.csdn.net，承载编辑器的根相对资源） --- */
    if (req.method === "GET") {
      const known = p === "/" || /^\/(style\.css|app\.js|vendor\/|api\/|mcp|cdn-proxy|editor-proxy)/.test(p);
      if (!known) return proxyCSDN(req, res, "editor.csdn.net", p, u.search, true);
      return serveStatic(res, p);
    }
    return sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    try { sendJSON(res, 500, { error: String(e.message || e).slice(0, 200) }); } catch {}
  }
};
const server = http.createServer(handler);

process.on("uncaughtException", (e) => console.error("[uncaught]", e.message));
process.on("unhandledRejection", (e) => console.error("[unhandled]", String(e).slice(0, 200)));

server.listen(PORT, () => {
  console.log(`[web-ui] CSDN 增强版已启动: http://localhost:${PORT}`);
});
// 旧 3011「编辑器同源代理」已随自建编辑器下线：单端口 3010 提供全部功能
