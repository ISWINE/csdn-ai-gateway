/**
 * 三通道封装（SSE 事件全部直通，服务端零缓冲）：
 * - chat   ：ai-middle（think:true，<think> 标签服务端切分）
 * - agent  ：phoenix agent-chat（复用根目录 phoenix_agent.js）
 * - search ：aisearch Dify RAG（节点过程 + references + 纯搜索模式）
 */
const crypto = require("crypto");
const { oldHeaders, casHeaders, qsSign } = require("./signer");

const AI_MIDDLE_URL = "https://bizapi.csdn.net/ai-middle/gpt/assistant";
const AISearch = {
  base: "https://bizapi.csdn.net",
  sessionCreate: "/aisearch/v2/api/smart/session/create",
  difyStream: "/aisearch/v2/api/stream/smart/chat/message/stream",
  modelList: "/aisearch/v2/api/smart/llm/model/list",
};

/** SSE 通用读取：按行拆 data: 载荷，回调 (payload字符串) */
async function readSSE(res, onData, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch {} return; }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
  const tail = buf.trim();
  if (tail.startsWith("data:")) onData(tail.slice(5).trim());
}

/** <think> 切分器：容忍标签跨 chunk 断裂 */
function makeThinkSplitter(emit) {
  const OPEN = "<think>", CLOSE = "</think>";
  let buf = "", inThink = false;
  const partialHold = (str, tag) => {
    const max = Math.min(str.length, tag.length - 1);
    for (let k = max; k > 0; k--) if (str.endsWith(tag.slice(0, k))) return k;
    return 0;
  };
  function feed(chunk) {
    buf += chunk;
    while (true) {
      if (inThink) {
        const e = buf.indexOf(CLOSE);
        if (e === -1) {
          const hold = partialHold(buf, CLOSE);
          if (hold) { if (buf.slice(0, buf.length - hold)) emit({ t: "think", text: buf.slice(0, buf.length - hold) }); buf = buf.slice(buf.length - hold); }
          else { if (buf) emit({ t: "think", text: buf }); buf = ""; }
          return;
        }
        if (buf.slice(0, e)) emit({ t: "think", text: buf.slice(0, e) });
        buf = buf.slice(e + CLOSE.length); inThink = false; emit({ t: "think-end" });
      } else {
        const o = buf.indexOf(OPEN);
        if (o === -1) {
          const hold = partialHold(buf, OPEN);
          if (hold) { if (buf.slice(0, buf.length - hold)) emit({ t: "answer", text: buf.slice(0, buf.length - hold) }); buf = buf.slice(buf.length - hold); }
          else { if (buf) emit({ t: "answer", text: buf }); buf = ""; }
          return;
        }
        if (buf.slice(0, o)) emit({ t: "answer", text: buf.slice(0, o) });
        buf = buf.slice(o + OPEN.length); inThink = true; emit({ t: "think-start" });
      }
    }
  }
  function flush() { if (buf) { if (inThink) emit({ t: "think", text: buf }); else emit({ t: "answer", text: buf }); buf = ""; } }
  return { feed, flush };
}

/** 多轮历史 → ai-middle 单字符串 content（与网关同思路，轻量渲染） */
function buildContent(history, message) {
  const turns = history.slice(-10).map((m) => (m.role === "user" ? `用户：${m.content}` : `助手：${m.content}`));
  turns.push(`用户：${message}`);
  return turns.join("\n\n");
}

/** chat：ai-middle 流式，onEvent({t:...}) */
async function chatStream({ message, history = [] }, onEvent, signal) {
  const body = JSON.stringify({ think: true, content: buildContent(history, message), prompt: "", biz_no: "blog", sub_biz_no: "blog_writer_md" });
  const res = await fetch(AI_MIDDLE_URL, {
    method: "POST",
    headers: oldHeaders("POST", AI_MIDDLE_URL, "application/json", "https://app-blog.csdn.net/"),
    body,
    signal: signal || AbortSignal.timeout(300000),
  });
  if (!res.ok) { onEvent({ t: "error", msg: "上游 HTTP " + res.status }); return; }
  const splitter = makeThinkSplitter(onEvent);
  await readSSE(res, (payload) => {
    if (!payload || payload === "[DONE]") return;
    try {
      const j = JSON.parse(payload);
      if (j.code === 200 && typeof j.text === "string") splitter.feed(j.text);
      else if (j.code && j.code !== 200) onEvent({ t: "error", msg: j.msg || "上游错误 code=" + j.code });
    } catch {}
  }, signal);
  splitter.flush();
  onEvent({ t: "done" });
}

/** agent：phoenix 通道（复用根目录库），onEvent({t:...})。模型别名在此映射（后端只认 markdown_editor/... 原名）。
 *  空输出自动重试一次（V4 智能体偶发陷入内部工具循环不出正文）；done 时流式内容若非最终正文前缀（混入工具反馈），整段补发最终正文。 */
async function agentStream({ messages, model, fileUrl }, onEvent, signal) {
  const phoenix = require("../../phoenix_agent");
  const upstreamModel = (phoenix.MODEL_MAP && phoenix.MODEL_MAP[model]) || model || "markdown_editor/deepseek-v4-flash";
  const norm0 = messages.map((m) => ({ role: m.role, content: m.content }));
  // 平台内部工具反馈（第 N 条 xxx 无效/成功…）整行过滤；「用户可见输出」为空才触发重试
  const CHATTER = /^[^\n]*第\s*\d+\s*条[^\n]*(无效|成功)[^\n]*\n?/gm;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const norm = norm0.slice();
    if (attempt > 1 && norm.length) {
      const last = norm[norm.length - 1];
      norm[norm.length - 1] = { role: last.role, content: last.content + "\n\n（上一次没有输出任何正文。请跳过工具调用，直接完整输出结果正文。）" };
    }
    let raw = "", visible = "";
    const emit = (t) => { if (!t) return; visible += t; onEvent({ t: "answer", text: t }); };
    await phoenix.streamAgentChat(norm, { model: upstreamModel, signal, fileUrl }, (ev) => {
      if (ev.kind === "answer-delta") {
        raw += ev.delta || "";
        emit((ev.delta || "").replace(CHATTER, ""));
      }
      else if (ev.kind === "reasoning") onEvent({ t: "think", text: ev.delta });
      else if (ev.kind === "done") {
        const finalText = ev.answer || "";
        const finalOut = finalText.replace(CHATTER, "");
        const artifactOut = (ev.artifact || "").replace(CHATTER, "");
        if (finalText.length > raw.length) {
          if (finalText.startsWith(raw)) emit(finalText.slice(raw.length).replace(CHATTER, ""));
          else emit("\n\n---\n\n" + finalOut);
        }
        // 成品产物（attempt_completion）优先供编辑器同步；final 为滤噪后的完整回答
        if (artifactOut) onEvent({ t: "artifactText", text: artifactOut });
        if (finalOut) onEvent({ t: "final", text: finalOut });
        onEvent({ t: "done", artifact: ev.artifact });
      }
    });
    if (visible.replace(/\s/g, "").length > 0) break;
    if (signal && signal.aborted) break;
  }
}

/** Dify 快模型纯文本补全（工具模式后端）：非流式聚合，空回复+错误才抛 */
async function fastChat({ query, modelId = "3", webSearch = "0" }, signal) {
  let answer = "", errored = null;
  await searchStream({ query, docIds: "", webSearch, modelId, pure: false, sid: "" }, (ev) => {
    if (ev.t === "answer") answer += ev.text || "";
    else if (ev.t === "error") errored = ev.msg;
  }, signal);
  if (!answer && errored) throw new Error("上游错误: " + errored);
  return answer.trim();
}

/** 站内搜索 references 的提取：优先"搜索结果解析"节点，兜底扫描带 url 的结果数组 */
function extractRefs(nodeOutputs) {
  const out = [];
  const scan = (v) => {
    if (Array.isArray(v)) {
      for (const it of v) {
        if (it && typeof it === "object" && it.title && it.url) out.push({ id: it.id || "", title: String(it.title), url: String(it.url) });
        else if (typeof it === "object") scan(it);
      }
    } else if (v && typeof v === "object") {
      for (const k of Object.keys(v)) scan(v[k]);
    }
  };
  scan(nodeOutputs);
  const seen = new Set();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).slice(0, 12);
}

/** AI 搜索文档上传：docUpload → {docId, fileName}（multipart 字面量签名，字段名必须 docFile） */
async function uploadSearchDoc(buf, name) {
  const url = AISearch.base + "/aisearch/v2/api/upload/docUpload";
  const fd = new FormData();
  fd.append("docFile", new Blob([buf]), name);
  fd.append("upload_type", "");
  const h = casHeaders("POST", url, "multipart/form-data", "https://i-search.csdn.net/");
  h["X-Ca-Signed-Content-Type"] = "multipart/form-data";
  delete h["Content-Type"];
  const r = await fetch(url, { method: "POST", headers: h, body: fd, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("docUpload HTTP " + r.status);
  const j = await r.json();
  if (!j.data || !j.data.id) throw new Error("docUpload 响应异常: " + JSON.stringify(j).slice(0, 150));
  return { docId: j.data.id, fileName: j.data.fileName };
}

/** search：Dify RAG 流式。pure=true 时拿到检索结果即断流（纯搜索模式）；docIds 传文档分析（webSearch 自动关）；sid 传则续接会话（后端记忆多轮） */
async function searchStream({ query, webSearch = "1", modelId = "1", pure = false, docIds = "", sid = "" }, onEvent, signalOuter) {
  const ac = new AbortController();
  if (signalOuter) signalOuter.addEventListener("abort", () => ac.abort());
  const ws = docIds ? "0" : webSearch;
  // 1. 建 session（老密钥）；调用方传 sid 则续接（后端"获取上一轮对话详情"节点负责多轮记忆）
  let sessId = sid;
  if (!sessId) {
    const createUrl = AISearch.base + AISearch.sessionCreate;
    const cr = await fetch(createUrl, { method: "POST", headers: oldHeaders("POST", createUrl, "application/json", "https://i-search.csdn.net/"), body: "{}", signal: ac.signal });
    sessId = (await cr.json()).data.sid;
  }
  onEvent({ t: "sid", sid: sessId, reused: !!sid });
  // 2. Dify 流（cas 密钥 + 三明治 sign）
  const body = {
    inputs: { docIds, modelId, platform: "pc", url: "", webSearch: ws },
    query, queryId: "", sessionId: sessId, trace_id: crypto.randomUUID(),
  };
  const sign = qsSign(body, ["query", "queryId", "sessionId"]);
  const url = `${AISearch.base}${AISearch.difyStream}?sign=${sign}`;
  const res = await fetch(url, { method: "POST", headers: casHeaders("POST", url, "application/json", "https://i-search.csdn.net/"), body: JSON.stringify(body), signal: ac.signal });
  if (!res.ok) { onEvent({ t: "error", msg: "上游 HTTP " + res.status }); return; }
  let refsSent = false;
  let answerStarted = false;
  await readSSE(res, (payload) => {
    if (!payload || payload === "[DONE]" || payload === "[CLOSE]") return;
    try {
      const j = JSON.parse(payload);
      if (j.event === "workflow_started") onEvent({ t: "wf", id: j.data && j.data.workflow_id });
      else if (j.event === "node_started") onEvent({ t: "node", title: j.data && j.data.title, state: "run" });
      else if (j.event === "node_finished") {
        const title = (j.data && j.data.title) || "";
        onEvent({ t: "node", title, state: j.data && j.data.status });
        const outputs = j.data && j.data.outputs;
        if (outputs) {
          const refs = /搜索|search/i.test(title) ? extractRefs(outputs) : [];
          if (refs.length && !refsSent) { refsSent = true; onEvent({ t: "refs", refs }); }
          if (/related/i.test(title)) {
            const qs = [];
            const scanStr = (v) => {
              if (typeof v === "string" && v.length > 4 && v.length < 120) qs.push(v);
              else if (Array.isArray(v)) v.forEach(scanStr);
              else if (v && typeof v === "object") Object.values(v).forEach(scanStr);
            };
            scanStr(outputs);
            if (qs.length) onEvent({ t: "related", items: [...new Set(qs)].slice(0, 4) });
          }
        }
        if (pure && refsSent && !ac.signal.aborted) { ac.abort(); onEvent({ t: "done", pure: true, stoppedAt: title }); }
      } else if (j.event === "message" && typeof j.answer === "string") {
        if (!answerStarted) { answerStarted = true; onEvent({ t: "answer-start" }); }
        if (j.answer) onEvent({ t: "answer", text: j.answer });
      } else if (j.event === "message_end") {
        onEvent({ t: "done" });
      } else if (j.event === "error") {
        onEvent({ t: "error", msg: j.msg || JSON.stringify(j).slice(0, 120) });
      }
    } catch {}
  }, ac.signal);
  if (!ac.signal.aborted) onEvent({ t: "done" });
}

/** 模型列表（smart 表 + 老表合并，全部走 Dify 检索流；老表数字 id 已实测 Dify 直接认），缓存 10 分钟 */
let modelCache = { at: 0, data: null };
async function listModels() {
  if (Date.now() - modelCache.at < 600000 && modelCache.data) return modelCache.data;
  const out = { search: [], agent: [] };
  const ref = "https://i-search.csdn.net/";
  // 1) smart 表（Dify 原生）
  try {
    const url = AISearch.base + AISearch.modelList;
    const r = await fetch(url, { headers: oldHeaders("GET", url, "application/json", ref) });
    const j = await r.json();
    for (const m of j.data || []) {
      out.search.push({ id: String(m.modelId), name: m.modelName, desc: m.description || "", tags: m.tags || [] });
    }
  } catch (e) { out.searchError = String(e.message).slice(0, 80); }
  // 2) 老表补充（modelId 数字与 smart 表同空间可通；id 冲突的跳过——smart 优先）
  try {
    const url = AISearch.base + "/aisearch/v2/api/llm/model/list";
    const r = await fetch(url, { headers: oldHeaders("GET", url, "application/json", ref) });
    const j = await r.json();
    for (const m of (j.data && j.data.list) || []) {
      const id = String(m.modelId);
      if (out.search.some((x) => x.id === id)) continue;
      const think = Number(m.thinkSupport) === 2;
      out.search.push({
        id,
        name: m.modelName + (think ? " 🧠" : ""),
        desc: m.description || "",
        tags: m.tags || [],
      });
    }
  } catch (e) { out.searchMergeError = String(e.message).slice(0, 80); }
  try {
    const phoenix = require("../../phoenix_agent");
    out.agent = Object.entries(phoenix.MODEL_MAP).map(([k, v]) => ({ id: k, name: k, upstream: v }));
  } catch (e) { out.agentError = String(e.message).slice(0, 80); }
  modelCache = { at: Date.now(), data: out };
  return out;
}

module.exports = { chatStream, agentStream, searchStream, listModels, buildContent, uploadSearchDoc, fastChat };
