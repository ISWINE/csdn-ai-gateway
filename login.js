/**
 * CSDN 自动扫码登录 → 采集全部 cookie（含 httpOnly 的 bot 验证 cookie）
 *
 * 用法： node login.js
 * 流程： 打开可见浏览器 → 你扫码/验证码登录 → 程序检测到登录态 →
 *        自动导出全部 CSDN cookie 到 csdn-cookies.json → 浏览器自动关闭
 *
 * 之后 csdn-ai-server.js 每次请求都会热读取该文件，无需重启。
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PROFILE = path.join(__dirname, "login_profile");
const OUT = path.join(__dirname, "csdn-cookies.json");
const LOGIN_URL = "https://passport.csdn.net/account/login";

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
  });

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log("浏览器已打开 CSDN 登录页。请扫码 / 验证码登录（最长等待 10 分钟）...");

  // 轮询登录态：UserToken/UserInfo/SESSION 三个核心 cookie 至少出现两个
  let ok = false;
  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(2000);
    const cs = await context.cookies();
    const core = cs.filter(c => ["UserToken", "UserInfo", "SESSION", "UserNick"].includes(c.name));
    if (core.length >= 2) { ok = true; break; }
    if (i % 5 === 4) console.log(`  等待登录中... ${((i + 1) * 2)}s`);
  }

  if (!ok) {
    console.log("超时未检测到登录态，退出。");
    await context.close();
    process.exit(2);
  }

  // 登录成功：再访问一次编辑器域，确保 app-blog/bizapi 相关 cookie 也签发
  try {
    await page.goto("https://editor.csdn.net/md/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch {}

  const all = await context.cookies();
  const csdn = all.filter(c => (c.domain || "").includes("csdn.net"));
  // Playwright 格式即注入格式，直接落盘（去掉无关字段）
  const out = csdn.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
  }));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const names = out.map(c => c.name);
  const key = ["SESSION", "UserToken", "UserInfo"].filter(n => names.includes(n));
  const bot = names.filter(n => /^bc_bot|waf_/.test(n));
  console.log(`\n✓ 登录态采集完成：共 ${out.length} 个 cookie 已写入 csdn-cookies.json`);
  console.log(`  核心登录 cookie: ${key.join(", ") || "未检测到!"}`);
  console.log(`  bot 验证 cookie: ${bot.join(", ") || "未检测到（可能影响 AI 调用）"}`);
  console.log(`\n服务端每次请求都会热读取该文件，无需重启。`);

  await page.waitForTimeout(3000);
  await context.close();
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });