/**
 * 反向隧道本地端（家里电脑跑）：出站连云端桥，把公网请求转给本地 csdn-ai-server，流式回传
 *
 * 前置：本地先起 node csdn-ai-server.js 3000
 * 启动： node agent.js <桥地址> [token]    （也可用环境变量 BRIDGE_URL / BRIDGE_TOKEN）
 * 自愈：断线指数退避重连（5s 起、60s 封顶）；每 4 分钟 ping /health 兼防免费层休眠
 *       （容器睡了 → ping 叫醒 → SSE 重连，全程无需人工干预）
 * 注意：Node fetch 不读 HTTPS_PROXY，需保证能直连桥地址
 */
const BRIDGE_URL = (process.argv[2] || process.env.BRIDGE_URL || "").replace(/\/+$/, "");
const BRIDGE_TOKEN = process.argv[3] || process.env.BRIDGE_TOKEN || "";
const UPSTREAM = (process.env.LOCAL_UPSTREAM || "http://127.0.0.1:3000").replace(/\/+$/, "");
const PING_EVERY = 4 * 60 * 1000;
const MAX_BACKOFF = 60000;

let backoff = 5000;
let pingTimer = null;
let currentReader = null;   // 供保活 ping 失败时打断挂起的 SSE read，加速重连
const aborts = new Map();   // 派活 id -> AbortController

function log(...a) { console.log("[agent]", ...a); }

function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

function startPing() {
  stopPing();
  pingTimer = setInterval(async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(BRIDGE_URL + "/health", { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      if (!j.agent) {
        log("警告：/health 报告 agent 未连接（本连接可能已被顶掉），强制重连");
        try { currentReader && currentReader.cancel(); } catch {}
      }
    } catch (e) {
      log("保活 ping 失败（桥可能睡了/断了）：", e.message, "→ 强制重连");
      try { currentReader && currentReader.cancel(); } catch {}
    }
  }, PING_EVERY);
}

function postResult(id, payload) {
  return fetch(`${BRIDGE_URL}/bridge/res/${id}`, {
    method: "POST",
    headers: { "x-bridge-token": BRIDGE_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const RES_HEADER_DROP = /^(connection|content-length|transfer-encoding|keep-alive)$/i;

async function handleWork(ev) {
  const ctl = new AbortController();
  aborts.set(ev.id, ctl);
  try {
    const r = await fetch(UPSTREAM + ev.url, {
      method: ev.method,
      headers: ev.headers || {},
      body: ev.method === "GET" || ev.method === "HEAD" ? undefined : ev.body,
      signal: ctl.signal,
    });
    const headers = {};
    r.headers.forEach((v, k) => { if (!RES_HEADER_DROP.test(k)) headers[k] = v; });
    await postResult(ev.id, { t: "head", status: r.status, headers });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await postResult(ev.id, { t: "chunk", b64: Buffer.from(value).toString("base64") }); // 逐块顺序回传
    }
    await postResult(ev.id, { t: "done" });
  } catch (e) {
    await postResult(ev.id, { t: "err", message: String((e && e.message) || e) }).catch(() => {});
  } finally {
    aborts.delete(ev.id);
  }
}

async function connectOnce() {
  const res = await fetch(BRIDGE_URL + "/bridge/agent", {
    headers: { "x-bridge-token": BRIDGE_TOKEN, Accept: "text/event-stream" },
  });
  if (!res.ok) throw new Error("桥返回 HTTP " + res.status + (res.status === 403 ? "（token 不对）" : ""));
  backoff = 5000;
  log("已连上桥：", BRIDGE_URL);
  startPing();
  const decoder = new TextDecoder();
  let buf = "";
  const reader = res.body.getReader();
  currentReader = reader;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        if (!data) continue; // ": ping" 注释行
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.t === "abort") {
          const c = aborts.get(ev.id);
          if (c) { c.abort(); aborts.delete(ev.id); }
          continue;
        }
        if (ev.id && ev.method) handleWork(ev).catch(() => {});
      }
    }
  } finally {
    currentReader = null;
    stopPing();
  }
}

async function main() {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    console.error("用法: node agent.js <桥地址> <token>   （或 BRIDGE_URL / BRIDGE_TOKEN 环境变量）");
    process.exit(1);
  }
  log("本地上游:", UPSTREAM, "｜ 桥:", BRIDGE_URL);
  for (;;) {
    try {
      await connectOnce();
      log("连接关闭");
    } catch (e) {
      log("连接异常:", e.message);
    }
    log(Math.round(backoff / 1000) + "s 后重连…");
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }
}
main();
