#!/usr/bin/env node
/**
 * CSDN AI 助手封装
 * -------------------------------
 * 把"浏览器里的 CSDN AI 助手"封装成可编程接口。
 *
 * 用法：
 *   node csdn-ai.js login                  # 首次：打开浏览器登录 CSDN，会话保存到 ./user_data
 *   node csdn-ai.js ask  "你的提示"        # 单次调用，打印 AI 回复
 *   node csdn-ai.js ask  "提示" --json     # JSON 输出
 *   node csdn-ai.js discover               # 抓取 AI 助手背后的真实网络请求（API）
 *   node csdn-ai.js server [port]          # 启动 HTTP API，默认 3000
 *
 * HTTP API:
 *   POST /ask  {"prompt":"..."}  ->  {"response":"..."}
 *   GET  /ask?prompt=...         ->  {"response":"..."}
 *
 * 说明：
 * - 登录态持久化在 ./user_data，登录一次后续免登录。
 * - AI 助手是跨源 iframe（app-blog.csdn.net），无法直接抓取其 HTTP 接口，
 *   因此默认采用"驱动浏览器"的方式；discover 模式可抓到它真实发出的请求。
 */

const { chromium } = require("playwright");
const http = require("http");
const path = require("path");

const EDITOR_URL =
  "https://editor.csdn.net/md/?not_checkout=1&spm=1000.2115.3001.4503";
const USER_DATA = path.join(__dirname, "user_data");
const VIEWPORT = { width: 1280, height: 720 };

// AI 助手输入框 / 发送按钮坐标（1280x720 视口、AI 面板默认布局下验证）
const INPUT_XY = { x: 1000, y: 627 };
const SEND_XY = { x: 1157, y: 647 };

// ---------- 工具 ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const promptParts = rest.filter((a) => a !== "--json");
  return { cmd, prompt: promptParts.join(" "), json };
}

/** 等待 AI 助手 iframe 出现（也即已登录） */
async function waitForAiIframe(page, timeoutMs = 15000) {
  await page.waitForFunction(
    () => !!document.querySelector('iframe[src*="aiChatNew"]'),
    { timeout: timeoutMs },
  );
}

/** 获取 AI 助手 iframe 的 frameLocator */
function aiFrame(page) {
  return page.frameLocator('iframe[src*="aiChatNew"]');
}

/** 在 AI 助手里触发一次对话，返回 AI 的回复文本 */
async function askInPage(page, prompt) {
  const frame = aiFrame(page);

  // 0) 切到「Chat」模式：避免 Agent 模式把回复直接写进编辑器（副作用）
  const chatTab = frame
    .locator(".ai-mode-change-item")
    .filter({ hasText: "Chat" });
  if ((await chatTab.count()) > 0) {
    const isActive = await chatTab
      .first()
      .evaluate((el) => el.classList.contains("active"));
    if (!isActive) {
      await chatTab.first().click();
      await page.waitForTimeout(1500); // 等待模式切换动画
    }
  }

  // 1) 点击输入框（可见的 contenteditable），用 locator 让 Playwright 自动换算坐标
  const input = frame
    .locator("[contenteditable='true']")
    .filter({ visible: true })
    .first();
  await input.click();
  // 清空并输入
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type(prompt);

  // 2) 点击发送按钮（button.btn-chat，纸飞机图标）
  const sendBtn = frame
    .locator("button.btn-chat")
    .filter({ visible: true })
    .first();
  await sendBtn.click();

  // 3) 等待回复完成：「重新生成」按钮出现（成功时还有「复制」，失败时只有「重新生成」）
  await frame
    .getByRole("button", { name: "重新生成" })
    .waitFor({ state: "visible", timeout: 90000 });

  // 4) 提取回复正文：回复按钮所在消息块里、不含 button 的子节点
  //    用真实 Frame 对象执行 evaluate（frameLocator 无 evaluate）
  const fr = page.frames().find((f) => f.url().includes("aiChatNew"));
  const response = await fr.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent.trim() === "重新生成",
    );
    if (!btn) return null;
    const msg = btn.parentElement.parentElement;
    const content = Array.from(msg.children).find(
      (c) => !c.querySelector("button"),
    );
    return content ? content.textContent.trim() : null;
  });

  return response;
}

// ---------- 命令实现 ----------

async function cmdLogin() {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: false,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("domcontentloaded");
  console.log(
    "已在浏览器中打开 CSDN 编辑器。请登录，登录后编辑器会自动加载，此窗口不会关闭。",
  );
  try {
    await waitForAiIframe(page, 300000);
    console.log("检测到已登录 ✓  会话已保存到 ./user_data");
  } catch {
    console.log("登录超时（5 分钟），请重试。");
  }
  // 保持打开，让用户看到结果；5 秒后关闭
  await page.waitForTimeout(5000);
  await context.close();
}

async function cmdAsk(prompt, json) {
  if (!prompt) {
    console.error("用法: node csdn-ai.js ask \"你的提示\"");
    process.exit(2);
  }
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();
  try {
    await page.goto(EDITOR_URL);
    await page.waitForLoadState("domcontentloaded");
    try {
      await waitForAiIframe(page, 15000);
    } catch {
      throw new Error(
        "未检测到登录态。请先运行: node csdn-ai.js login  登录一次",
      );
    }
    const response = await askInPage(page, prompt);
    if (json) {
      console.log(JSON.stringify({ prompt, response }));
    } else {
      console.log(response || "(无回复)");
    }
  } finally {
    await context.close();
  }
}

async function cmdDiscover() {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();
  const captured = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("csdn") || url.includes("ai")) {
      captured.push({
        url,
        method: req.method(),
        headers: req.headers(),
        postData: req.postData(),
      });
    }
  });
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("get-config") || url.includes("assistant/models") || url.includes("ai-middle")) {
      let body = "";
      try { body = await res.text(); } catch {}
      captured.push({ _response: true, url, status: res.status(), body: body.slice(0, 2000) });
    }
  });
  try {
    await page.goto(EDITOR_URL);
    await page.waitForLoadState("domcontentloaded");
    await waitForAiIframe(page, 15000);
    await askInPage(page, "用一句话介绍 Markdown");
  } finally {
    // 无论 AI 是否响应，都打印捕获到的请求（请求发出即被捕获）
    console.log("=== AI 助手发出的网络请求 ===");
    console.log(JSON.stringify(captured, null, 2));
    await context.close();
  }
}

async function cmdServer(port = 3000) {
  // 长驻浏览器，避免每次请求都重启
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    viewport: VIEWPORT,
  });
  let ready = false;
  let busy = false;

  const server = http.createServer(async (req, res) => {
    let prompt = "";
    if (req.method === "POST") {
      const body = await new Promise((r) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => r(d));
      });
      try {
        prompt = JSON.parse(body || "{}").prompt || "";
      } catch {
        /* ignore */
      }
    } else {
      const u = new URL(req.url, "http://localhost");
      prompt = u.searchParams.get("prompt") || "";
    }
    if (!prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 prompt" }));
      return;
    }
    if (busy) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "服务忙，请稍后重试" }));
      return;
    }
    busy = true;
    try {
      if (!ready) {
        const page = await context.newPage();
        await page.goto(EDITOR_URL);
        await page.waitForLoadState("domcontentloaded");
        try {
          await waitForAiIframe(page, 15000);
        } catch {
          throw new Error("未登录。请先运行: node csdn-ai.js login");
        }
        ready = page; // 复用这一页
      }
      const page = ready;
      const response = await askInPage(page, prompt);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ prompt, response }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    } finally {
      busy = false;
    }
  });

  server.listen(port, () => {
    console.log(`CSDN AI API 已启动: http://localhost:${port}`);
    console.log(`示例: curl -X POST http://localhost:${port}/ask -H "Content-Type: application/json" -d '{"prompt":"用一句话介绍 Markdown"}'`);
  });

  process.on("SIGINT", async () => {
    await context.close();
    server.close();
    process.exit(0);
  });
}

// ---------- 入口 ----------

(async () => {
  const { cmd, prompt, json } = parseArgs(process.argv);
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "ask":
      await cmdAsk(prompt, json);
      break;
    case "discover":
      await cmdDiscover();
      break;
    case "server":
      await cmdServer(process.argv[3] ? Number(process.argv[3]) : 3000);
      break;
    default:
      console.log([
        "CSDN AI 助手封装",
        "  node csdn-ai.js login              # 首次登录",
        '  node csdn-ai.js ask  "提示"        # 单次调用',
        "  node csdn-ai.js discover           # 抓取真实 API",
        "  node csdn-ai.js server [port]      # HTTP API",
      ].join("\n"));
  }
})();