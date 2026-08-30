/**
 * CSDN AI 直接调用完整版：think 模式 + SSE 流合并
 */
const crypto = require("crypto");
const fs = require("fs");

const APP_KEY = "203803574";
function uidOf() {
  try { return fs.readFileSync(require("path").join(__dirname, "uid.txt"), "utf8").trim(); } catch (e) {}
  return "";
}

const APP_SECRET = "9znpamsyl2c7cdrr9sas0le9vbc3r6ba";
const API_URL = "https://bizapi.csdn.net/ai-middle/gpt/assistant";

function nonce() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (16 * Math.random()) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function sign(meth, url, accept, ct) {
  const p = url.replace(/^(?=^.{3,255}$)(http(s)?:\/\/)?(www\.)?[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.csdn\.net)/, "").split("?")[0];
  const n = nonce();
  const s = [meth.toUpperCase(), accept, "", ct, "", `x-ca-key:${APP_KEY}`, `x-ca-nonce:${n}`, p].join("\n");
  return { signature: crypto.createHmac("sha256", APP_SECRET).update(s).digest("base64"), nonce: n };
}

function cookieHeader() {
  // 包含所有 csdn 相关域（passport 的 bc_bot_*/waf_* bot 验证 cookie 也必须带上）
  return JSON.parse(fs.readFileSync(__dirname + "/csdn-cookies.json", "utf8"))
    .filter((c) => (c.domain || "").includes("csdn.net"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

async function askRawResponse(prompt, { think = true } = {}) {
  const body = JSON.stringify({ think, content: prompt, prompt: "", biz_no: "blog", sub_biz_no: "blog_writer_md" });
  const doFetch = () => {
    const { signature, nonce: n } = sign("POST", API_URL, "*/*", "application/json");
    return fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Referer: "https://app-blog.csdn.net/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        Cookie: cookieHeader(),
        uid: uidOf(),
        "x-ca-key": APP_KEY,
        "x-ca-nonce": n,
        "x-ca-timestamp": String(Date.now()),
        "x-ca-signature-headers": "x-ca-key,x-ca-nonce",
        "x-ca-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(300000), // 5 分钟超时（原 10 分钟），瞬时故障由调用方重试
    });
  };
  let res;
  try {
    res = await doFetch();
  } catch (e) {
    // 连接失败/超时等瞬时故障自动重试一次（每次重新签名）
    console.error("[retry] 上游首次请求失败(" + e.message + ")，3 秒后重试");
    await new Promise((r) => setTimeout(r, 3000));
    res = await doFetch();
  }
  if (res.status !== 200) throw new Error("HTTP " + res.status);
  return res;
}

/** 增量解析 CSDN 的 SSE 流，逐段回调 {text}（含 <think> 标记）或抛错 */
async function streamDeltas(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", merged = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (j.text) { merged += j.text; onDelta(j.text); }
        else if (j.msg && j.code !== 200) throw new Error(j.msg);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return merged;
}

/**
 * 抢救 DSML 工具调用块：把模型想写入文件的内容还原为 Markdown 代码块。
 * 格式：<｜DSML｜invoke name="xxx"><｜DSML｜parameter name="yyy" string="true">值</…></｜DSML｜invoke>
 */
function salvageDSML(input) {
  if (!input || input.indexOf("DSML") === -1) return input;
  // 标签中段容忍 "DSML" 字样：<｜DSML｜invoke> / <｜｜DSML｜｜invoke> / <｜invoke> 三种变体通吃
  return input.replace(
    /<[\uFF5C|]+(?:DSML[\uFF5C|]*)*invoke\s+name="([^"]*)"([\s\S]*?)<\/[\uFF5C|]+(?:DSML[\uFF5C|]*)*invoke\s*>/g,
    (m, toolName, inner) => {
      const params = {};
      const re = /<[\uFF5C|]+(?:DSML[\uFF5C|]*)*parameter\s+name="([^"]*)"[^>\n]*>([\s\S]*?)<\/[\uFF5C|]+(?:DSML[\uFF5C|]*)*parameter\s*>/g;
      let pm;
      while ((pm = re.exec(inner))) params[pm[1]] = pm[2].replace(/^\n+|\n+$/g, "");
      // 找文件路径类参数作文件名，最大的参数当内容
      let filename = "", contentParam = null, contentLen = 0;
      for (const [k, v] of Object.entries(params)) {
        if (/path|file|filename/i.test(k) && v.length < 300) filename = v;
        if (v.length > contentLen) { contentLen = v.length; contentParam = [k, v]; }
      }
      if (!contentParam) return `**[模型尝试调用工具: ${toolName}]**`;
      const [pk, pv] = contentParam;
      const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
      const langMap = { html: "html", htm: "html", js: "javascript", ts: "typescript", css: "css", py: "python", json: "json", md: "markdown", java: "java", sh: "bash" };
      const lang = langMap[ext.toLowerCase()] || ext;
      let md = `\n\n---\n**[${toolName}] ${filename ? "目标文件: `" + filename + "`" : "参数: " + pk}**\n\n`;
      if (pv.length > 80 || /[{;\n]/.test(pv)) md += "```" + lang + "\n" + pv + "\n```\n";
      else md += pv + "\n";
      return md;
    }
  );
}

/**
 * 清洗模型输出中的内部标记泄漏：
 * 1. 先抢救 DSML 工具块里的实际内容（转成代码块）
 * 2. 再移除所有残留的特殊竖线标记
 */
function sanitizeText(input) {
  if (!input) return "";
  let s = salvageDSML(input);
  // 完整的 DSML 块（若未被抢救覆盖）
  let prev;
  do {
    prev = s;
    s = s.replace(/<[\uFF5C|]+DSML[\s\S]*?<\/[\uFF5C|]+(?:DSML[\uFF5C|]*)*DSML[^>\n]*>/g, "");
  } while (s !== prev);
  // 残留的所有 DSML/特殊竖线标记本身
  s = s.replace(/<[\uFF5C|]+\s*\/?\s*DSML[^>\n]*>/g, "");
  s = s.replace(/<\/?[\uFF5C|][^>\n]{0,120}>/g, "");
  // 连续重复行折叠（≥3 次相同行压到 2 次），防复读循环刷屏
  s = s.replace(/(^|\n)([^\n]+)\n(?:\2\n)+/g, "$1$2\n$2\n");
  return s.trim();
}

async function ask(prompt, { think = true } = {}) {
  const res = await askRawResponse(prompt, { think });
  if (res.status !== 200) throw new Error("HTTP " + res.status);
  const text = await res.text();
  // 合并 SSE 中所有 text 字段
  let merged = "";
  for (const m of text.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)) {
    merged += JSON.parse('"' + m[1] + '"');
  }
  // 错误检测（无 text 片段时看 msg）
  if (!merged) {
    const err = text.match(/"msg":"([^"]*)"/);
    if (err) throw new Error(err[1]);
  }
  // 分离思考过程和正式答案
  const thinkMatch = merged.match(/<think>([\s\S]*?)(<\/think>|$)/);
  let reasoning = "", answer = merged;
  if (thinkMatch) {
    reasoning = thinkMatch[1];
    answer = merged.slice(thinkMatch.index + thinkMatch[0].length);
  }
  return { answer: sanitizeText(answer), reasoning: sanitizeText(reasoning) };
}

/**
 * 提取文本中的 DSML invoke 块 → [{name, params:{}}]
 * 格式：<｜DSML｜invoke name="xxx"><｜DSML｜parameter name="p" string="true">值</…></｜DSML｜invoke>
 */
function extractDSMLInvokes(input) {
  if (!input || input.indexOf("invoke") === -1) return [];
  const out = [];
  const reI = /<[\uFF5C|]+(?:DSML[\uFF5C|]*)*invoke\s+name="([^"]*)"([^>]*>)([\s\S]*?)<\/[\uFF5C|]+(?:DSML[\uFF5C|]*)*invoke\s*>/g;
  let m;
  while ((m = reI.exec(input))) {
    const params = {};
    const reP = /<[\uFF5C|]+(?:DSML[\uFF5C|]*)*parameter\s+name="([^"]*)"[^>\n]*>([\s\S]*?)<\/[\uFF5C|]+(?:DSML[\uFF5C|]*)*parameter\s*>/g;
    let p;
    while ((p = reP.exec(m[3]))) params[p[1]] = p[2].replace(/^\n+|\n+$/g, "");
    // 兼容：参数值可能没有闭合标签，直接取剩余全部
    if (Object.keys(params).length === 0 && m[3].trim()) {
      const firstGt = m[3].indexOf(">");
      if (firstGt !== -1) {
        const keyM = m[3].slice(0, firstGt).match(/name="([^"]*)"/);
        if (keyM) params[keyM[1]] = m[3].slice(firstGt + 1).replace(/^\n+|\n+$/g, "");
      }
    }
    out.push({ name: m[1], params });
  }
  return out;
}

module.exports = { ask, askRawResponse, streamDeltas, sanitizeText, salvageDSML, extractDSMLInvokes };

if (require.main === module) {
  ask("用一句话介绍 Markdown 是什么")
    .then(({ answer, reasoning }) => {
      console.log("=== 答案 ===\n" + answer);
      console.log("\n=== 思考过程（前200字）===\n" + reasoning.slice(0, 200));
    })
    .catch((e) => { console.error("ERR:", e.message); process.exit(1); });
}