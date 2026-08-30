/**
 * Phoenix agent-chat 通道（CSDN 官方编辑器 AI 面板同款接口）
 *
 * 端点：POST /blog/phoenix/console/v1/stream/ai/assistant/agent-chat
 * - query 支持字符串或 [{role,content}] 标准多轮（实测）
 * - 模型：markdown_editor/deepseek-v4-flash | markdown_editor/deepseek-v4-pro
 * - SSE：meta.type=answer（累积式全文）/ tool（attempt_completion 等工具 JSON）/ usage
 *   结束标记：data:[DONE] 与 data:[TASK_DONE]
 *
 * 对网关暴露两个函数：
 *   streamAgentChat(...) — 逐事件回调
 *   agentChatComplete(...) — 非流式，返回 {answer, reasoning, usage}
 */
const crypto = require("crypto");
const fs = require("fs");

const APP_KEY = "203803574";
function uidOf() {
  try { return fs.readFileSync(require("path").join(__dirname, "uid.txt"), "utf8").trim(); } catch (e) {}
  return "";
}

const APP_SECRET = "9znpamsyl2c7cdrr9sas0le9vbc3r6ba";
const AGENT_CHAT_URL = "https://bizapi.csdn.net/blog/phoenix/console/v1/stream/ai/assistant/agent-chat";
const DOC_UPLOAD_URL = "https://bizapi.csdn.net/blog/phoenix/console/v1/ai/file/doc/upload";

// 客户端模型名 → CSDN modelId
const MODEL_MAP = {
  "csdn-agent-flash": "markdown_editor/deepseek-v4-flash",
  "csdn-agent-pro": "markdown_editor/deepseek-v4-pro",
};

function nonce() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (16 * Math.random()) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function cookieHeader() {
  return JSON.parse(fs.readFileSync(__dirname + "/csdn-cookies.json", "utf8"))
    .filter((c) => (c.domain || "").includes("csdn.net"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function signHeaders(method, url, ct) {
  const u = new URL(url);
  const n = nonce();
  const s = [method.toUpperCase(), "*/*", "", ct || "", "", `x-ca-key:${APP_KEY}`, `x-ca-nonce:${n}`, u.pathname].join("\n");
  return {
    Accept: "*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    Referer: "https://app-blog.csdn.net/",
    Origin: "https://app-blog.csdn.net",
    "Content-Type": ct || "application/json",
    Cookie: cookieHeader(),
    uid: uidOf(),
    "x-ca-key": APP_KEY,
    "x-ca-nonce": n,
    "x-ca-timestamp": String(Date.now()),
    "x-ca-signature-headers": "x-ca-key,x-ca-nonce",
    "x-ca-signature": crypto.createHmac("sha256", APP_SECRET).update(s).digest("base64"),
  };
}

/** 上传本地文档到 CSDN（返回 {fileName, url}，url 可作 agent-chat 的 kwargs.file_url） */
async function uploadDoc(filePath) {
  let p = String(filePath).trim();
  // Git Bash 风格路径兼容：/tmp/... → Windows 临时目录
  if (/^\/tmp(\/|$)/.test(p)) p = require("os").tmpdir() + p.slice(4);
  const abs = require("path").resolve(p);
  const buf = fs.readFileSync(abs);
  if (buf.length > 8 * 1024 * 1024) throw new Error("文件超过 8MB 上传上限");
  const blob = new Blob([buf]);
  const fd = new FormData();
  fd.append("docFile", blob, require("path").basename(abs));
  // 签名用字面量 multipart/form-data（配合 X-Ca-Signed-Content-Type 头），fetch 自动补 boundary
  const headers = signHeaders("POST", DOC_UPLOAD_URL, "multipart/form-data");
  headers["X-Ca-Signed-Content-Type"] = "multipart/form-data";
  delete headers["Content-Type"];
  const res = await fetch(DOC_UPLOAD_URL, { method: "POST", headers, body: fd, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("doc upload HTTP " + res.status);
  const j = await res.json();
  if (!j.data || !j.data.url) throw new Error("doc upload 响应异常: " + JSON.stringify(j).slice(0, 200));
  return { fileName: j.data.fileName, url: j.data.url };
}

/** 从工具事件 JSON 中提取对用户有价值的正文产物 */
function toolArtifact(type, params = {}, meta = {}) {
  if (type === "attempt_completion") return params.result || "";
  // 编辑器补丁类工具：真正的内容在 new_text/content 里
  const cands = [params.new_text, params.content, params.text, meta.output && meta.output.content];
  return cands.find((v) => typeof v === "string" && v.trim()) || "";
}

/**
 * 解析一行 SSE data 载荷 → 规范化事件
 * 返回 null（忽略）或 {kind:"answer"|"tool"|"usage"|"done", ...}
 */
function parseEventLine(payload) {
  if (payload === "[DONE]" || payload === "[TASK_DONE]") return { kind: "done" };
  let j;
  try { j = JSON.parse(payload); } catch { return null; }
  const meta = j.meta || {};
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  if (meta.type === "answer") return { kind: "answer", content: msg.content || "", reasoning: msg.reasoning_content || "", finish: !!meta.finish, meta };
  if (meta.type === "tool") {
    let tool = null, artifact = "";
    try {
      tool = JSON.parse(msg.content || "{}");
      artifact = toolArtifact(tool.type, tool.params || {}, meta);
    } catch { /* 半截 JSON：finish=false 的分片可能不完整，忽略 */ }
    return { kind: "tool", action: meta.action || (tool && tool.type) || "", content: msg.content || "", artifact, finish: !!meta.finish, meta };
  }
  if (meta.type === "usage") return { kind: "usage", meta };
  return null;
}

/**
 * 流式调用 agent-chat。
 * onEvent({kind:"answer-delta", delta}) / {kind:"reasoning", delta} / {kind:"done", answer, artifact, usage}
 * answer 是流式可见文本（累积切片已还原为增量）；artifact 是工具事件携带的正文产物（可能为空）。
 */
async function streamAgentChat(messages, { model = "markdown_editor/deepseek-v4-flash", think = false, signal, fileUrl } = {}, onEvent = () => {}) {
  const kwargs = {};
  if (fileUrl) kwargs.file_url = fileUrl; // 官方上传文档后的分析入口（kwargs.file_url）
  const body = {
    model,
    query: messages,
    request_id: crypto.randomUUID(),
    kwargs,
    extra_body: think ? { thinking: { type: "enabled" } } : {},
  };
  const res = await fetch(AGENT_CHAT_URL, {
    method: "POST",
    headers: signHeaders("POST", AGENT_CHAT_URL, "application/json"),
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error("agent-chat HTTP " + res.status + " " + (await res.text()).slice(0, 200));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", answer = "", reasoning = "", artifact = "", usage = null, sawToolArtifact = false;

  const handleParsed = (ev) => {
    if (!ev) return;
    if (ev.kind === "answer") {
      // content 为累积式全文 → 还原增量
      if (ev.content.length > answer.length && ev.content.startsWith(answer)) {
        const delta = ev.content.slice(answer.length);
        answer = ev.content;
        onEvent({ kind: "answer-delta", delta });
      } else if (ev.content !== answer && !answer.startsWith(ev.content)) {
        // 内容替换（如补丁场景的总结语）：不追加，仅记录到 answer 末态
        answer = answer && answer.length >= ev.content.length ? answer : ev.content;
      }
      if (ev.reasoning && ev.reasoning.length > reasoning.length) {
        const rd = ev.reasoning.slice(reasoning.length);
        reasoning = ev.reasoning;
        onEvent({ kind: "reasoning", delta: rd });
      }
      // finish=true 的 answer 事件若带 action（如 markdown_editor.patch）说明正文在工具里
      if (ev.finish && ev.meta && ev.meta.action && ev.meta.action !== "") sawToolArtifact = true;
    } else if (ev.kind === "tool") {
      if (ev.artifact && ev.artifact.length >= artifact.length) artifact = ev.artifact;
      if (ev.finish) sawToolArtifact = true;
    } else if (ev.kind === "usage") {
      usage = ev.meta;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const ev = parseEventLine(line.slice(5).trim());
      if (ev && ev.kind === "done") continue;
      handleParsed(ev);
    }
  }

  const finalAnswer = artifact && artifact.length > answer.length ? artifact : answer;
  onEvent({ kind: "done", answer: finalAnswer, streamedAnswer: answer, artifact, usage });
  return { answer: finalAnswer, streamedAnswer: answer, artifact, reasoning, usage };
}

/** 非流式：拿到最终完整文本 */
async function agentChatComplete(messages, opts = {}) {
  let captured = null;
  const r = await streamAgentChat(messages, opts, (ev) => { if (ev.kind === "done") captured = ev; });
  return { answer: (captured && captured.answer) || r.answer, reasoning: r.reasoning, usage: r.usage };
}

module.exports = { MODEL_MAP, streamAgentChat, agentChatComplete, parseEventLine, toolArtifact, uploadDoc };
