/**
 * 反向隧道全链路回归（不触 CSDN）：mock 上游 + bridge-server + agent 三进程联跑
 * 验证：agent 上线、公网面鉴权、流式逐块透传、请求头透传、路径无关代理、健康检查
 * 运行： node tests/bridge-e2e.js
 */
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT_UP = 3101;
const PORT_BRIDGE = 3102;
const TOKEN = "test-token-123";
const BRIDGE = `http://127.0.0.1:${PORT_BRIDGE}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " —— " + (detail || "")}`);
}

function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = req.url.split("?")[0];
      if (p === "/echo") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ auth: req.headers["authorization"] || null, path: req.url, bodyLen: body.length }));
        });
        return;
      }
      if (p === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      // 模拟网关的 SSE 流式端点
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const parts = ["数据块1", "数据块2", "数据块3"];
      let i = 0;
      const t = setInterval(() => {
        if (i < parts.length) res.write(`data: ${JSON.stringify({ text: parts[i++] })}\n\n`);
        else { clearInterval(t); res.write("data: [DONE]\n\n"); res.end(); }
      }, 30);
    });
    server.listen(PORT_UP, () => resolve(server));
  });
}

function spawnProc(script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => out.push(c));
  child.out = () => out.join("");
  return child;
}

async function pollAgentOnline() {
  for (let i = 0; i < 50; i++) {
    try {
      const j = await (await fetch(BRIDGE + "/health")).json();
      if (j.agent) return j;
    } catch {}
    await wait(200);
  }
  return null;
}

async function main() {
  setTimeout(() => { console.error("❌ 整体超时"); process.exit(1); }, 25000).unref();

  const upstream = await startMockUpstream();
  const bridge = spawnProc("bridge-server.js", { PORT: String(PORT_BRIDGE), BRIDGE_TOKEN: TOKEN });
  const agent = spawnProc("agent.js", { BRIDGE_URL: BRIDGE, BRIDGE_TOKEN: TOKEN, LOCAL_UPSTREAM: `http://127.0.0.1:${PORT_UP}` });

  try {
    const health = await pollAgentOnline();
    check("agent 上线（/health.agent=true）", health && health.agent === true, JSON.stringify(health));

    // 1) 流式透传
    const r = await fetch(BRIDGE + "/v1/chat/completions?x=1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await r.text();
    check("派活 HTTP 200", r.status === 200, "实际 " + r.status);
    check("Content-Type 透传为 text/event-stream", (r.headers.get("content-type") || "").includes("text/event-stream"), r.headers.get("content-type"));
    check("三个数据块顺序完整", text.includes("数据块1") && text.includes("数据块2") && text.includes("数据块3"), text.slice(0, 120));
    check("[DONE] 结尾透传", text.includes("data: [DONE]"));

    // 2) 请求头透传（Authorization 原样到达本地网关）+ 路径带 query
    const echo = await (await fetch(BRIDGE + "/echo?a=1", { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    check("Authorization 透传", echo.auth === `Bearer ${TOKEN}`, JSON.stringify(echo));
    check("路径与 query 原样代理", echo.path === "/echo?a=1", echo.path);

    // 3) 公网面鉴权
    const noKey = await fetch(BRIDGE + "/v1/models");
    const badKey = await fetch(BRIDGE + "/v1/models", { headers: { Authorization: "Bearer wrong" } });
    check("无 key → 401", noKey.status === 401, "实际 " + noKey.status);
    check("错 key → 401", badKey.status === 401, "实际 " + badKey.status);

    // 4) GET 请求（无 body）也正常派活
    const models = await (await fetch(BRIDGE + "/v1/models", { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    check("GET 无 body 派活正常", models && models.object === "list", JSON.stringify(models));
  } finally {
    agent.kill();
    bridge.kill();
    upstream.close();
  }

  const fail = results.filter((r) => !r.ok);
  if (fail.length) {
    console.error("\n=== agent 输出 ===\n" + agent.out());
    console.error("=== bridge 输出 ===\n" + bridge.out());
    process.exit(1);
  }
  console.log(`\n全部通过（${results.length}/${results.length}）`);
}

main().catch((e) => { console.error("❌ 测试异常:", e); process.exit(1); });
