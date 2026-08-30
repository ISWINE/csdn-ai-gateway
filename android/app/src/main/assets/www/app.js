/* CSDN 增强版 · 前端逻辑（原生 JS，零依赖除 marked） */
"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  mode: "chat",                       // chat | agent | search
  agentModel: "csdn-agent-flash",
  searchModelId: "1",
  models: { search: [], agent: [] },
  session: null,                      // {id,title,mode,messages:[...]}
  fileQueue: [],                      // 待上传文件队列（按发送才真正上传）
  generating: false,
  abort: null,
};

/* ---------- 基础 ---------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), 2200);
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function md(text) { try { return marked.parse(text, { breaks: true }); } catch (e2) { return "<pre>" + esc(text) + "</pre>"; } }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function nowTitle() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 会话 ---------- */
function newSession(mode) {
  state.session = { id: uid(), title: nowTitle(), mode: mode || state.mode, messages: [] };
  renderStream(); renderSessions();
}
function saveHistory() {
  if (!state.session) return;
  fetch("/api/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.session) });
}
async function loadHistory() {
  try {
    const db = await (await fetch("/api/history")).json();
    renderSessions(db.sessions || []);
  } catch (e2) {}
}
async function deleteSession(id, ev) {
  ev.stopPropagation();
  await fetch("/api/history/" + id, { method: "DELETE" });
  if (state.session && state.session.id === id) newSession();
  loadHistory();
}
function openSession(s) {
  state.session = JSON.parse(JSON.stringify(s));
  state.mode = s.mode || "chat";
  syncTabs(); renderStream(); renderSessions();
}
function renderSessions(list) {
  if (!list) return; // 保留现有 DOM（当前会话置顶由调用方处理）
  const el = $("#sessionList");
  el.innerHTML = "";
  for (const s of list) {
    if (!s.messages || !s.messages.length) continue; // 空会话不显示
    const d = document.createElement("div");
    d.className = "session-item" + (state.session && state.session.id === s.id ? " active" : "");
    d.innerHTML = `<span class="t">${esc(s.title)}</span><button class="del" title="删除">✕</button>`;
    d.onclick = () => { openSession(s); document.getElementById("sidebar").classList.remove("open"); const m = document.getElementById("sbMask"); if (m) m.style.display = "none"; };
    d.querySelector(".del").onclick = (e) => deleteSession(s.id, e);
    el.appendChild(d);
  }
}
function refreshSidebar() {
  fetch("/api/history").then((r) => r.json()).then((db) => renderSessions(db.sessions || []));
}

/* ---------- 模式与模型 ---------- */
function syncTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === state.mode));
  $("#webSearchWrap").style.display = state.mode === "search" ? "inline-flex" : "none";
  $("#pureWrap").style.display = state.mode === "search" ? "inline-flex" : "none";
  renderModelSelect();
  renderQuickActions();
}
function renderModelSelect() {
  const sel = $("#modelSelect");
  sel.style.display = (state.mode === "agent" || state.mode === "search") ? "inline-block" : "none";
  if (state.mode === "agent") {
    sel.innerHTML = state.models.agent.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    sel.value = state.agentModel;
  } else if (state.mode === "search") {
    sel.innerHTML = state.models.search.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    sel.value = state.searchModelId;
  }
  sel.onchange = () => { if (state.mode === "agent") state.agentModel = sel.value; else state.searchModelId = sel.value; };
}
async function loadModels() {
  try {
    state.models = await (await fetch("/api/models")).json();
  } catch (e2) {}
  renderModelSelect();
}

/* ---------- 消息渲染 ---------- */
function clearWelcome() { const w = $("#welcome"); if (w) w.remove(); }
function addUserMsg(text) {
  clearWelcome();
  const d = document.createElement("div");
  d.className = "msg user";
  d.innerHTML = `<div class="who">我 · ${esc(new Date().toLocaleTimeString())}</div><div class="bubble">${esc(text)}</div>`;
  $("#stream").appendChild(d);
  scrollBottom();
  return d;
}
function addAssistantShell() {
  clearWelcome();
  const d = document.createElement("div");
  d.className = "msg assistant";
  d.innerHTML = `<div class="who">CSDN AI · ${esc(new Date().toLocaleTimeString())}</div>
    <div class="bubble">
      <div class="conn"></div>
      <details class="think" style="display:none"><summary>思考过程</summary><div class="body"></div></details>
      <div class="nodes"></div>
      <div class="refs"></div>
      <div class="md"></div>
      <div class="related"></div>
    </div>`;
  $("#stream").appendChild(d);
  scrollBottom();
  return {
    root: d,
    connEl: d.querySelector(".conn"),
    thinkWrap: d.querySelector(".think"),
    thinkBody: d.querySelector(".think .body"),
    nodesEl: d.querySelector(".nodes"),
    refsEl: d.querySelector(".refs"),
    mdEl: d.querySelector(".md"),
    relatedEl: d.querySelector(".related"),
    thinkText: "", answerText: "",
  };
}
function scrollBottom() { const s = $("#stream"); s.scrollTop = s.scrollHeight; }

/* markdown 流式渲染节流 */
function makeMdRenderer(el) {
  let pending = "", timer = null;
  return (text, final) => {
    pending = text;
    if (final) {
      // 必须撤销未触发的流式 paint：否则它会在 final 渲染后用带光标的旧闭包覆盖
      if (timer) { clearTimeout(timer); timer = null; }
      el.innerHTML = md(pending);
      return;
    }
    if (timer) return;
    timer = setTimeout(() => { timer = null; el.innerHTML = md(pending) + ' <span class="cursor">▍</span>'; }, 90);
  };
}

/* Dify 节点管线可视化（官网没有的增强） */
const NODE_ORDER = ["意图识别", "站内搜索", "联网检索", "结果解析", "生成"];
const NODE_MATCH = { "意图识别": ["意图识别"], "站内搜索": ["站内搜索"], "联网检索": ["HTTP 请求", "联网"], "结果解析": ["搜索结果解析", "解析"], "生成": ["LLM", "二次调用", "app_csdn"] };
function makeNodeTracker(el) {
  const chips = {};
  NODE_ORDER.forEach((n) => {
    const c = document.createElement("span");
    c.className = "node-chip"; c.textContent = n;
    el.appendChild(c); chips[n] = c;
  });
  return {
    event(title, nodeState) {
      for (const [label, keys] of Object.entries(NODE_MATCH)) {
        if (keys.some((k) => (title || "").includes(k))) {
          const c = chips[label];
          if (nodeState === "run") c.className = "node-chip run";
          else if (nodeState === "succeeded") c.className = "node-chip succeeded";
        }
      }
    },
  };
}

/* ---------- 发送 ---------- */
function setGenerating(on) {
  state.generating = on;
  $("#sendBtn").disabled = on;
  $("#stopBtn").style.display = on ? "inline-block" : "none";
}
async function send(text) {
  if (state.generating) return;
  const tplText = tplCompose();
  if (tplText) {
    if (tplText.err) return toast(tplText.err);
    text = (text || tplText).trim();
    tpl = null; renderTpl();
  } else text = (text || $("#input").value).trim();
  if (!text && !state.fileQueue.length) return;
  if (!text) return toast("请附一句想问文档什么（文档无法单独发送）");

  // 队列里有文件：此刻才真正上传（失败则保留输入与队列，便于重试）
  let fileUrl, docId;
  try {
    if (state.mode === "agent" && state.fileQueue.some((f) => f.target === "file")) {
      const r = await uploadItem(state.fileQueue.find((f) => f.target === "file"));
      fileUrl = r.fileUrl;
    }
    if (state.mode === "search" && state.fileQueue.some((f) => f.target === "doc")) {
      const r = await uploadItem(state.fileQueue.find((f) => f.target === "doc"));
      docId = r.docId;
    }
  } catch (e) { return toast("上传失败：" + e.message); }

  $("#input").value = ""; autoGrow();
  if (!state.session || state.session.mode !== state.mode) newSession();
  const s = state.session;
  let edFull = null, edNote = "";
  if (state.mode === "agent" && document.getElementById("edAttach").checked) {
    const art = edTextEl().value.trim();
    const h = art ? edHash(art) : "";
    if (art && h !== s.edHash) {
      edFull = "【编辑器全文开始】\n" + art + "\n【编辑器全文结束】\n\n" + text;
      edNote = "（已附编辑器全文 " + art.length + " 字）";
      s.edHash = h;
    }
  }
  s.messages.push({ role: "user", content: edFull || text, display: text + edNote });
  addUserMsg(text + edNote);

  const shell = addAssistantShell();
  const renderMd = makeMdRenderer(shell.mdEl);
  const tracker = makeNodeTracker(shell.nodesEl);
  setGenerating(true);
  state.abort = new AbortController();
  let hadError = null;

  const handle = (ev) => {
    if (ev.t === "sid") {
      if (!s.searchSid) { s.searchSid = ev.sid; saveHistory(); }
      if (shell.connEl) shell.connEl.textContent = `🔌 ${ev.reused ? "续接会话" : "新连接"} · sid ${String(ev.sid).slice(0, 8)} · 生成中…`;
    }
    else if (ev.t === "think-start") { shell.thinkWrap.style.display = "block"; }
    else if (ev.t === "think") { shell.thinkText += ev.text || ""; shell.thinkBody.textContent = shell.thinkText; scrollBottom(); }
    else if (ev.t === "think-end") { /* noop */ }
    else if (ev.t === "node") tracker.event(ev.title, ev.state);
    else if (ev.t === "refs") renderRefs(shell.refsEl, ev.refs);
    else if (ev.t === "answer-start") { shell.thinkWrap.open = false; }
    else if (ev.t === "answer") { shell.answerText += ev.text || ""; renderMd(shell.answerText); scrollBottom(); }
    else if (ev.t === "related") renderRelated(shell.relatedEl, ev.items);
    else if (ev.t === "error") { hadError = ev.msg; toast("出错了：" + ev.msg); }
    else if (ev.t === "final") { shell.edFinal = ev.text || ""; }
    else if (ev.t === "artifactText") { shell.edArtifact = ev.text || ""; }
    else if (ev.t === "done") { /* handled after stream */ }
  };

  try {
    if (state.mode === "agent" && document.getElementById("toolMode").checked) {
      const res = await toolAgentRun(text, (tool, result) => {
        const chip = document.createElement("div");
        chip.className = "tool-step";
        chip.textContent = "🔧 " + tool + " · " + result;
        shell.mdEl.appendChild(chip);
        scrollBottom();
      });
      shell.answerText = res.text;
      if (shell.connEl) shell.connEl.textContent = "🛠 工具模式 · " + (res.toolLog.length ? res.toolLog.join(" → ") : "直答");
    } else {
    let path, body;
    if (state.mode === "chat") {
      path = "/api/chat";
      body = { message: text, history: s.messages.filter((m) => m.role !== "meta").slice(0, -1).slice(-10) };
    } else if (state.mode === "agent") {
      path = "/api/agent";
      const msgs = s.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }));
      body = { messages: msgs.slice(0, -1).concat([{ role: "user", content: edFull || text }]), model: state.agentModel, fileUrl };
    } else {
      path = "/api/search";
      body = { query: text, webSearch: $("#webSearch").checked ? "1" : "0", modelId: state.searchModelId, pure: $("#pureSearch").checked, docIds: docId ? String(docId) : undefined, sid: s.searchSid || undefined };
    }
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: state.abort.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx).trim(); buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { handle(JSON.parse(line.slice(5))); } catch (e2) {}
        }
      }
    }
    }
  } catch (e) {
    if (e.name !== "AbortError") { hadError = String(e.message || e); toast("请求失败：" + hadError); }
    else toast("已停止生成");
  }
  let finalText = shell.answerText;
  if (!finalText && hadError) {
    finalText = "⚠ 上游错误：" + hadError;
    if (/4000|服务器繁忙|登录|cookie/i.test(hadError))
      finalText += "\n\n提示：多为 cookie 缺失或失效（需含 passport 域 httpOnly bot cookie）。在电脑 006 目录运行 node login.js 重新扫码，再导出 cookie 文件导入本机。";
    else if (/Failed to fetch|NetworkError|超时|timeout/i.test(hadError))
      finalText += "\n\n提示：多为网络不通或上游无响应，可用 设置 → 运行诊断 查看连通性。";
  }
  renderMd(finalText || "（无输出）", true);
  if (shell.answerText) {
    // 编辑器同步优先取 attempt_completion 成品产物，其次滤噪后的完整回答——思考/规划过程不进编辑器
    const syncText = (shell.edArtifact && shell.edArtifact.length >= 50) ? shell.edArtifact : (shell.edFinal || shell.answerText);
    const bub = shell.mdEl.closest(".bubble") || shell.mdEl.parentElement;
    if (bub) addEdChips(bub, syncText);
    if (state.mode === "agent" && !(document.getElementById("toolMode") && document.getElementById("toolMode").checked) && !hadError && syncText.length >= 200) {
      edApply("append", syncText);
      edOpen(true);
      toast("✓ 智能体内容已同步到左侧编辑器（追加）");
    }
  }
  if (shell.connEl) shell.connEl.textContent = shell.connEl.textContent.replace("生成中…", hadError ? "出错" : "完成");
  s.messages.push({ role: "assistant", content: shell.answerText, think: shell.thinkText, refs: shell.refsEl._refs || [] });
  setGenerating(false);
  saveHistory(); refreshSidebar();
}

function stopGen() { if (state.abort) state.abort.abort(); }

/* 引用卡片 / 相关问题 */
function renderRefs(el, refs) {
  el._refs = refs;
  el.innerHTML = `<div class="refs">` + refs.map((r) =>
    `<div class="ref-card"><a href="${esc(r.url)}" target="_blank">${esc(r.title)}</a><span class="u">${esc(r.url)}</span></div>`).join("") + `</div>`;
}
function renderRelated(el, items) {
  el.innerHTML = `<div class="related">` + (items || []).map((q) => `<button onclick="fillInput(${JSON.stringify(q).replace(/"/g, "&quot;")})">${esc(q)}</button>`).join("") + `</div>`;
}

/* ---------- 快捷动作（官方模板原文） ---------- */
const QUICK = [
  { n: "📝 大纲生成", d: "技术文章大纲", tpl: "帮我写一篇关于[输入主题内容]的技术文章大纲" },
  { n: "💻 代码生成", d: "按需求生成代码", tpl: "请生成一段[输入编程语言]代码，实现以下功能：[输入代码要求]" },
  { n: "🎓 学术搜索", d: "找中文文献", tpl: "帮我找[输入主题内容]相关的中文文献" },
  { n: "✨ 智能排版", d: "修正空格标点", tpl: "自动修正空格、标点及英文大小写" },
  { n: "🔍 优化全文", d: "错别字与用词", tpl: "识别错别字，提供用词优化建议" },
  { n: "📌 提取摘要", d: "生成内容摘要", tpl: "自动根据全文，提取摘要，并插入标题下方" },
  { n: "🖼️ AI 配图", d: "插入 Mermaid 图", tpl: "分析全文,给文章插入Mermaid图表" },
];
function renderQuickActions() {
  const el = $("#quickActions");
  const list = state.mode === "search" ? QUICK.filter((q) => q.n.includes("学术")) : QUICK;
  el.innerHTML = list.map((q, i) => `<button class="qa" data-i="${i}"><span class="n">${q.n}</span><span class="d">${q.d}</span></button>`).join("");
  el.querySelectorAll(".qa").forEach((b) => {
    b.onclick = () => {
      const q = QUICK[Number(b.dataset.i)];
      if (/\[[^\]]+\]/.test(q.tpl)) { startTpl(q); toast("填好高亮内容后直接发送"); }
      else { $("#input").value = q.tpl; $("#input").focus(); }
    };
  });
}

/* ---------- 模板填空（CSDN 同款：占位符变高亮小输入框，只填空处） ---------- */
let tpl = null; // { segs: [{t:"text"|"slot", s, ph}] }
function startTpl(q) {
  const segs = [];
  q.tpl.split(/(\[[^\]]+\])/).forEach((part) => {
    if (!part) return;
    if (part.startsWith("[") && part.endsWith("]")) segs.push({ t: "slot", s: "", ph: part.slice(1, -1) });
    else segs.push({ t: "text", s: part });
  });
  tpl = segs.length ? { segs } : null;
  renderTpl();
}
function tplAutoWidth(inp) {
  const unit = Math.max(inp.value.length, (inp.placeholder || "输入").length);
  inp.style.width = Math.max(56, Math.min(320, unit * 14 + 34)) + "px";
}
function renderTpl() {
  const bar = document.getElementById("tplBar");
  const row = document.querySelector("#composer .input-row");
  if (!bar || !row) return;
  if (!tpl) { bar.style.display = "none"; row.style.display = ""; return; }
  bar.style.display = "flex";
  row.style.display = "none";
  bar.innerHTML = "";
  tpl.segs.forEach((seg) => {
    if (seg.t === "text") {
      const sp = document.createElement("span");
      sp.className = "tpl-txt"; sp.textContent = seg.s;
      bar.appendChild(sp);
    } else {
      const inp = document.createElement("input");
      inp.className = "tpl-slot"; inp.placeholder = seg.ph; inp.value = seg.s;
      inp.addEventListener("input", () => { seg.s = inp.value; tplAutoWidth(inp); });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
      bar.appendChild(inp);
    }
  });
  const sb = document.createElement("button");
  sb.className = "primary"; sb.textContent = "发送";
  sb.onclick = () => send();
  bar.appendChild(sb);
  const x = document.createElement("button");
  x.className = "tpl-x"; x.textContent = "✕"; x.title = "取消模板";
  x.onclick = () => { tpl = null; renderTpl(); $("#input").focus(); };
  bar.appendChild(x);
  bar.querySelectorAll(".tpl-slot").forEach((inp) => tplAutoWidth(inp));
  const first = bar.querySelector(".tpl-slot");
  if (first) first.focus();
}
function tplCompose() {
  if (!tpl) return null;
  for (const seg of tpl.segs) if (seg.t === "slot" && !seg.s.trim()) return { err: "还有未填写的占位：" + seg.ph };
  return tpl.segs.map((sg) => sg.s).join("");
}

/* ---------- 工具模式智能体（DeepSeek-V4-Flash + 自定义工具协议，不走 phoenix 通道） ---------- */
const TOOL_MODEL_ID = "3"; // DeepSeek-V4-Flash（Dify）
const TOOL_SPEC = [
  "你是接入用户 Markdown 编辑器的编辑智能体，通过工具调用完成用户任务。",
  "每次回复只输出一行 JSON（无代码块无解释无多余文字），从以下工具中选一个：",
  '"{"tool":"read_editor"}" —— 读取编辑器当前全文',
  '"{"tool":"write_editor","content":"<替换编辑器的完整新文章>"}" —— 整篇替换（覆盖前请先 read_editor）',
  '"{"tool":"append_editor","content":"<追加内容>"}" —— 追加到文末',
  '"{"tool":"task_finish","summary":"<给用户看的最终答复，Markdown>"}" —— 任务完成时必须调用它结束；summary 给用户完整交代',
  "规则：任务未完成不要调用 task_finish；不要重复调用完全相同的工具；每次只调用一个工具。",
].join('\n');
function parseToolCall(text) {
  const t = (text || "").trim();
  if (!t.startsWith("{")) return null;
  try { const j = JSON.parse(t); if (j && j.tool) return j; } catch (e) {}
  return null;
}
async function fastCall(query) {
  const r = await (await fetch("/api/fast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, modelId: TOOL_MODEL_ID }) })).json();
  if (r.error) throw new Error(r.error);
  return r.text || "";
}
async function toolAgentRun(instruction, onStep) {
  const article = edTextEl().value.trim();
  let query = [TOOL_SPEC, "", "【编辑器当前全文】", article || "（空）", "【结束】", "", "用户指令：" + instruction].join("\n");
  const toolLog = [];
  let lastHash = "", repeatCount = 0, lastAnswer = "";
  const MAX_TURNS = 6;
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const out = await fastCall(query);
    const call = parseToolCall(out);
    if (!call) return { text: out, toolLog, turns: turn };  // 隐式停止：无工具调用即最终答复
    if (call.tool === "task_finish") return { text: String(call.summary || "任务完成"), toolLog, turns: turn };  // 显式闭环
    const hash = call.tool + "@" + JSON.stringify(call.content || call.summary || "");
    if (hash === lastHash) {
      repeatCount++;
      if (repeatCount >= 2) return { text: lastAnswer || ("已执行 " + toolLog.length + " 次工具调用后停止（检测到重复调用）"), toolLog, turns: turn };
      onStep(call.tool, "重复调用，要求收敛");
    transcript += "\n\n【助手】\n" + out + "\n【工具结果】FAILURE: 你重复调用了相同工具。任务已完成请立即调用 task_finish；否则换一种操作。"
      continue;
    }
    lastHash = hash; repeatCount = 0;
    let state = "SUCCESS", result = "ok";
    try {
      if (call.tool === "write_editor") { const c = String(call.content || ""); if (!c.trim()) throw new Error("content 为空"); edApply("replace", c); result = "已替换编辑器全文（" + c.length + " 字）"; }
      else if (call.tool === "append_editor") { const c = String(call.content || ""); if (!c.trim()) throw new Error("content 为空"); edApply("append", c); result = "已追加（" + c.length + " 字）"; }
      else if (call.tool === "read_editor") result = edTextEl().value || "（空）";
      else { state = "FAILURE"; result = "未知工具"; }
    } catch (e) { state = "FAILURE"; result = e.message || "执行失败"; }
    if (call.tool === "read_editor") lastAnswer = result;
    toolLog.push(call.tool);
    onStep(call.tool, state + " · " + result);
    transcript += "\n\n【助手】\n" + out + "\n【工具结果】" + state + ": " + result + "\n继续。任务全部完成后调用 task_finish 给出最终答复。"
  }
  return { text: lastAnswer || "（达到最大轮次 " + MAX_TURNS + "，已停止）", toolLog, turns: MAX_TURNS };
};

/* ---------- 划选菜单（官方划选六件套） ---------- */
const SEL_ACTIONS = [
  { n: "润色", tpl: "请润色以下内容，保持原意，使表达更流畅专业：\n\n" },
  { n: "扩写", tpl: "请扩写以下内容，补充细节与示例：\n\n" },
  { n: "翻译", tpl: "请将以下内容翻译成英文（若原文是英文则译成中文）：\n\n" },
  { n: "总结", tpl: "请总结以下内容的核心要点：\n\n" },
  { n: "生成标题", tpl: "请为以下内容生成 5 个吸引人的标题：\n\n" },
  { n: "内容建议", tpl: "请针对以下内容提出改进建议：\n\n" },
];
function setupSelMenu() {
  const menu = $("#selmenu");
  document.addEventListener("mouseup", (e) => {
    if (menu.contains(e.target)) return;
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    const inStream = sel && sel.anchorNode && $("#stream").contains(sel.anchorNode);
    if (!text || !inStream || text.length < 4) { menu.style.display = "none"; return; }
    menu.innerHTML = SEL_ACTIONS.map((a, i) => `<button data-i="${i}">${a.n}</button>`).join("");
    menu.style.display = "block";
    menu.style.left = Math.min(e.clientX, window.innerWidth - 340) + "px";
    menu.style.top = (e.clientY + 10) + "px";
    menu.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        const a = SEL_ACTIONS[Number(b.dataset.i)];
        $("#input").value = a.tpl + text;
        menu.style.display = "none";
        window.getSelection().removeAllRanges();
        $("#input").focus();
      };
    });
  });
}

/* ---------- 导出 ---------- */
function exportSession() {
  if (!state.session || !state.session.messages.length) return toast("当前会话为空");
  const s = state.session;
  let out = `# ${s.title}\n\n> CSDN 增强版导出 · ${s.mode} 模式 · ${new Date().toLocaleString()}\n\n`;
  for (const m of s.messages) {
    out += m.role === "user" ? `## 🧑 我\n\n${m.content}\n\n` : `## 🤖 CSDN AI\n\n${m.content}\n\n`;
    if (m.refs && m.refs.length) out += `**参考来源：**\n` + m.refs.map((r) => `- [${r.title}](${r.url})`).join("\n") + "\n\n";
  }
  const blob = new Blob([out], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `csdn-aug-${s.id}.md`;
  a.click();
  toast("已导出 Markdown");
}

/* ---------- 上传（入队，按发送才真正上传） ---------- */
async function doUpload(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast("文件超过 8MB 上限");
  let target = "file";
  if (state.mode === "search") target = "doc";            // AI 搜索：docUpload→docId→Dify 文档分析，模型不切
  else if (state.mode === "chat") { state.mode = "agent"; syncTabs(); toast("已切到智能体模式（文档分析），按发送后才会真正上传"); }
  state.fileQueue.push({ name: file.name, file, target, state: "" });
  renderFileQueue();
}
function renderFileQueue() {
  const chip = $("#fileChip");
  if (!state.fileQueue.length) { chip.style.display = "none"; chip.innerHTML = ""; return; }
  chip.style.display = "inline-flex";
  chip.innerHTML = state.fileQueue.map((f, i) =>
    `<span class="fitem">📄 ${esc(f.name)}${f.state ? ` · ${esc(f.state)}` : ""} <button data-i="${i}" class="rm">✕</button></span>`).join("")
    + `<span class="qhint">发送时随消息上传分析</span>`;
  chip.querySelectorAll(".rm").forEach((b) => {
    b.onclick = () => { state.fileQueue.splice(Number(b.dataset.i), 1); renderFileQueue(); };
  });
}
/** 上传指定队列项：doc → {docId}；file → {fileUrl}。失败抛错（保留原状便于重试） */
async function uploadItem(item) {
  item.state = "上传中…"; renderFileQueue();
  try {
    const t = item.target === "doc" ? "search" : "agent";
    const dataB64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(item.file);
    });
    const r = await (await fetch(`/api/upload?target=${t}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.name, data: dataB64 }) })).json();
    if (r.error) throw new Error(r.error);
    if (item.target === "doc") {
      if (!r.docId) throw new Error("响应中没有 docId");
      state.fileQueue = state.fileQueue.filter((f) => f !== item); renderFileQueue();
      return { docId: r.docId };
    }
    const url = r.file_url;
    if (!url) throw new Error("响应中没有 file_url");
    state.fileQueue = state.fileQueue.filter((f) => f !== item); renderFileQueue();
    return { fileUrl: url };
  } catch (e) {
    item.state = "失败"; renderFileQueue();
    throw e;
  }
}
function clearFileQueue() { state.fileQueue = []; renderFileQueue(); }

/* ---------- 输入框 ---------- */
function autoGrow() {
  const el = $("#input");
  el.style.height = "auto";
  el.style.height = Math.min(180, el.scrollHeight) + "px";
}
function fillInput(t) { $("#input").value = t; $("#input").focus(); autoGrow(); }

/* ---------- 主题 ---------- */
function initTheme() {
  const saved = localStorage.getItem("aug-theme") || "light";
  document.documentElement.dataset.theme = saved;
  $("#themeBtn").textContent = saved === "dark" ? "☀️" : "🌙";
}

let mcpTransport = (typeof window !== "undefined" && window.IS_ANDROID) ? "http" : "stdio", mcpOs = "win";
function mcpSnippet() {
  const S = settingsData || {};
  if (window.IS_ANDROID) {
    const li = window.__lanInfo || {};
    const host = li.ip || location.hostname || "127.0.0.1";
    const port = li.port || location.port || "3010";
    return JSON.stringify({ mcpServers: { "csdn-aggregate": { type: "http", url: "http://" + host + ":" + port + "/mcp" } } });
  }
  const winPath = "C:\\Users\\USER\\Documents\\z-code\\006\\web-ui\\mcp-server.js";
  const linPath = "/path/to/006/web-ui/mcp-server.js";
  if (mcpTransport === "stdio") {
    const p = mcpOs === "win" ? winPath : linPath;
    return JSON.stringify({ mcpServers: { "csdn-aggregate": { command: "node", args: [p] } } });
  }
  const base = "http://" + location.host;
  if (mcpTransport === "http") return JSON.stringify({ mcpServers: { "csdn-aggregate": { type: "http", url: base + "/mcp" } } });
  return JSON.stringify({ mcpServers: { "csdn-aggregate": { type: "sse", url: base + "/mcp/sse" } } });
}
function renderMcpSnippet() {
  const el = document.getElementById("mcpCode");
  if (el) el.textContent = mcpSnippet();
}

/* ---------- 登录 / Cookie ---------- */
async function refreshCookieStatus() {
  try {
    const s = await (await fetch("/api/auth/status")).json();
    const el = document.getElementById("cookieStatus");
    if (!s.exists || !s.count) { el.innerHTML = '<span class="bad">● 无 cookie（未登录）</span>'; return s; }
    const t = new Date(s.mtime).toLocaleString();
    el.innerHTML = `● <span class="${s.hasUserToken ? "ok" : "bad"}">${s.hasUserToken ? "已登录" : "无登录态"}</span> · ${s.count} 个 cookie · UserToken ${s.hasUserToken ? "✓" : "✗"} · bot ${s.hasBot ? "✓" : "✗"} · 更新于 ${t}`;
    if (s.qrRunning || (s.qrLines && s.qrLines.length)) {
      const log = document.getElementById("qrLog");
      log.style.display = "block";
      log.textContent = (s.qrLines || []).join("\n");
    }
    return s;
  } catch (e) { return null; }
}
async function refreshLanInfo() {
  const el = document.getElementById('lanInfo');
  if (!el) return;
  try {
    const n = await (await fetch('/api/lan-info')).json();
    window.__lanInfo = n;
    renderMcpSnippet();
    if (n.ip) {
      const url = 'http://' + n.ip + ':' + n.port;
      el.style.display = 'block';
      el.innerHTML = '📱 局域网访问: <a href="' + url + '" target="_blank">' + url + '</a> ' +
        '<button id="lanCopy" style="font-size:11px;padding:1px 6px">⧉ 复制网址</button>';
      document.getElementById('lanCopy').onclick = () => copyText(url, '网址已复制');
    } else { el.style.display = 'none'; }
  } catch (e) {}
}
function copyText(text, msg) {
  navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta); toast(msg + '（兜底模式）');
  });
}
async function doImport() {
  const text = document.getElementById("importText").value.trim();
  if (!text) return toast("先粘贴 cookie 内容");
  try {
    const j = await (await fetch("/api/auth/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })).json();
    if (j.error) return toast("导入失败：" + j.error);
    toast(`已导入 ${j.count} 个 cookie` + (j.warn ? "（⚠ " + j.warn + "）" : "，立即生效"));
    document.getElementById("importArea").style.display = "none";
    document.getElementById("importText").value = "";
    refreshCookieStatus();
  } catch (e) { toast("导入失败：" + e.message); }
}
async function doLogout() {
  if (!confirm("确认退出登录？当前 cookie 会备份到 .bak，可重新扫码/导入恢复。")) return;
  try {
    await fetch("/api/auth/logout", { method: "POST" });
    toast("已退出登录");
    refreshCookieStatus();
  } catch (e) { toast("操作失败：" + e.message); }
}

let qr2Poll = null;
async function startQr2() {
  clearInterval(qr2Poll);
  const area = document.getElementById("qr2Area");
  const img = document.getElementById("qr2Img");
  const tip = document.getElementById("qr2Tip");
  area.style.display = "block";
  img.removeAttribute("src");
  tip.textContent = "正在拉起官方登录页…";
  try { await fetch("/api/auth/qr2/start", { method: "POST" }); } catch (e) { return toast("启动失败：" + e.message); }
  qr2Poll = setInterval(async () => {
    let s;
    try { s = await (await fetch("/api/auth/qr2/status")).json(); } catch (e2) { return; }
    if (s.status === "qr" && s.qr) { img.src = s.qr; tip.textContent = "请用微信扫一扫，并在手机上确认"; }
    else if (s.status === "loading") tip.textContent = "正在拉起官方登录页…";
      else if (s.status === "success") { clearInterval(qr2Poll); area.style.display = "none"; toast("✓ 登录成功，cookie 已生效"); refreshCookieStatus(); setTimeout(refreshCookieStatus, 3000); setTimeout(refreshCookieStatus, 8000); }
    else if (s.status === "expired" || s.status === "error") {
      clearInterval(qr2Poll);
      tip.textContent = (s.err || "二维码已失效") + "（点上方按钮重新获取）";
    }
  }, 2000);
}

/* ---------- 左侧编辑器（Markdown 工具栏 + 比对/预览 + 智能体增删改查） ---------- */
let edBaseText = "";
let edTab = "src";
let edSaveTimer = null;

function edTextEl() { return document.getElementById("edText"); }
function edOpen(open) {
  document.body.classList.toggle("ed-open", open);
  const m = document.getElementById("edMask");
  if (m) m.style.display = (open && window.innerWidth <= 860) ? "block" : "none";
  try { localStorage.setItem("aug-ed-open", open ? "1" : "0"); } catch (e) {}
}
function edToggle() { edOpen(!document.body.classList.contains("ed-open")); }
function edTouch() {
  const t = edTextEl();
  if (edSaveTimer) clearTimeout(edSaveTimer);
  edSaveTimer = setTimeout(() => { try { localStorage.setItem("aug-editor", t.value); } catch (e2) {} }, 400);
  document.getElementById("edStat").textContent = t.value.length + " 字";
  if (edTab === "diff") edRenderDiff();
}
function edSetTab(v) {
  edTab = v;
  document.querySelectorAll("#edTabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  edTextEl().style.display = v === "src" ? "block" : "none";
  document.getElementById("edPreview").style.display = v === "prev" ? "block" : "none";
  document.getElementById("edDiff").style.display = v === "diff" ? "block" : "none";
  if (v === "prev") document.getElementById("edPreview").innerHTML = md(edTextEl().value);
  if (v === "diff") edRenderDiff();
}
function edRenderDiff() {
  const box = document.getElementById("edDiff");
  const cur = edTextEl().value;
  if (!edBaseText) { box.innerHTML = '<p class="hint" style="padding:10px">还没有基线：先整理好内容，点下方「设为基线」，之后的改动就能在这里红绿比对。</p>'; return; }
  const rows = edLineDiff(edBaseText, cur);
  let add = 0, del = 0;
  box.innerHTML = rows.map((r) => {
    if (r[0] === "+") add++;
    if (r[0] === "-") del++;
    const cls = r[0] === "+" ? "d-add" : (r[0] === "-" ? "d-del" : "d-same");
    const tag = r[0] === "+" ? "+" : (r[0] === "-" ? "−" : "");
    return '<div class="' + cls + '"><span class="d-tag">' + tag + "</span>" + esc(r[1]) + "</div>";
  }).join("") + '<p class="hint" style="padding:6px 10px">基线 ↔ 当前：新增 ' + add + " 行，删除 " + del + " 行</p>";
}
function edLineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  if (n * m > 400000) return [["-", a], ["+", b]];
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : (dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(["=", A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(["-", A[i]]); i++; }
    else { out.push(["+", B[j]]); j++; }
  }
  while (i < n) { out.push(["-", A[i]]); i++; }
  while (j < m) { out.push(["+", B[j]]); j++; }
  return out;
}
function edWrap(before, after, ph) {
  const t = edTextEl();
  const s = t.selectionStart, e = t.selectionEnd;
  const sel = t.value.slice(s, e) || (ph || "文本");
  t.value = t.value.slice(0, s) + before + sel + after + t.value.slice(e);
  t.selectionStart = s + before.length; t.selectionEnd = s + before.length + sel.length;
  t.focus(); edTouch();
}
function edLinePrefix(prefix) {
  const t = edTextEl();
  const s = t.selectionStart, e = t.selectionEnd;
  const ls = t.value.lastIndexOf("\n", s - 1) + 1;
  const seg = t.value.slice(ls, e);
  const lined = seg.split("\n").map((l) => (l.trim() === "" ? l : prefix + l.replace(/^(#{1,6} |[-*+] |> |\d+\. |- \[[ x]\] )/, ""))).join("\n");
  t.value = t.value.slice(0, ls) + lined + t.value.slice(e);
  t.selectionStart = ls; t.selectionEnd = ls + lined.length;
  t.focus(); edTouch();
}
function edInsert(text) {
  const t = edTextEl();
  const pos = (t.selectionStart != null ? t.selectionStart : t.value.length);
  t.value = t.value.slice(0, pos) + text + t.value.slice(pos);
  t.selectionStart = t.selectionEnd = pos + text.length;
  t.focus(); edTouch();
}
function edMenu(btn, items) {
  const old = document.getElementById("edMenuPop");
  if (old) { old.remove(); return; }
  const pop = document.createElement("div");
  pop.id = "edMenuPop";
  pop.innerHTML = items.map((it, i) => '<button data-i="' + i + '">' + it.n + "</button>").join("");
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 180)) + "px";
  pop.style.top = (r.bottom + 4) + "px";
  pop.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { items[Number(b.dataset.i)].fn(); pop.remove(); };
  });
  setTimeout(() => {
    const close = (ev) => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener("click", close); } };
    document.addEventListener("click", close);
  }, 0);
}
function edImage(file) {
  if (!file) return;
  const fr = new FileReader();
  fr.onload = async () => {
    const b64 = String(fr.result).split(",")[1] || "";
    try {
      const r = await (await fetch("/api/upload?target=agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, data: b64 }) })).json();
      if (r.error) throw new Error(r.error);
      if (!r.file_url) throw new Error("响应中没有 file_url");
      edInsert("\n![" + file.name + "](" + r.file_url + ")\n");
      toast("图片已上传并插入");
    } catch (e) { toast("图片上传失败：" + e.message + "（可点 🔗 手动插链接）"); }
  };
  fr.readAsDataURL(file);
}
function edExport() {
  const blob = new Blob([edTextEl().value], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "editor-" + new Date().toISOString().slice(0, 10) + ".md";
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast("已导出 .md（编辑内容平时自动存本机）");
}
function edApply(kind, text) {
  const t = edTextEl();
  if (kind === "insert") edInsert(text);
  else if (kind === "append") { t.value = t.value ? t.value + "\n\n" + text : text; edTouch(); toast("已追加到编辑器文末"); }
  else if (kind === "replace") { t.value = text; edTouch(); toast("已替换编辑器全文"); }
  else if (kind === "clear") { if (confirm("确认清空编辑器？")) { t.value = ""; edTouch(); } }
}
function addEdChips(bubble, text) {
  const acts = document.createElement("div");
  acts.className = "ed-acts";
  acts.innerHTML = '<button data-k="append">⤓ 追加到编辑器</button><button data-k="insert">⤓ 插入光标处</button><button data-k="replace">⟳ 替换编辑器</button><button data-k="copy">复制</button>';
  bubble.appendChild(acts);
  acts.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.k === "copy") { copyText(text, "已复制"); return; }
      edApply(b.dataset.k, text);
    };
  });
}
function edHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return str.length + "-" + h.toString(36);
}
function initEdPanel() {
  const t = edTextEl();
  if (!t) return;
  t.value = localStorage.getItem("aug-editor") || "";
  document.getElementById("edStat").textContent = t.value.length + " 字";
  t.addEventListener("input", edTouch);
  document.getElementById("edBtn").onclick = edToggle;
  document.getElementById("edClose").onclick = () => edOpen(false);
  const mk = document.getElementById("edMask");
  if (mk) mk.onclick = () => edOpen(false);
  document.querySelectorAll("#edTabs button").forEach((b) => { b.onclick = () => edSetTab(b.dataset.v); });
  const act = (k) => document.querySelector('#edToolbar [data-act="' + k + '"]');
  if (!act("bold")) return;
  act("bold").onclick = () => edWrap("**", "**", "加粗样式");
  act("italic").onclick = () => edWrap("*", "*", "斜体样式");
  act("heading").onclick = () => edLinePrefix("## ");
  act("strike").onclick = () => edWrap("~~", "~~", "删除线格式");
  act("list").onclick = (e) => edMenu(e.currentTarget, [
    { n: "• 无序列表", fn: () => edLinePrefix("- ") },
    { n: "1. 有序列表", fn: () => edLinePrefix("1. ") },
    { n: "☑ 任务列表", fn: () => edLinePrefix("- [ ] ") },
  ]);
  act("code").onclick = (e) => edMenu(e.currentTarget, [
    { n: "行内代码", fn: () => edWrap("`", "`", "在这里插入代码片") },
    { n: "代码块", fn: () => edInsert("\n```\ncode\n```\n") },
  ]);
  act("fmt").onclick = (e) => edMenu(e.currentTarget, [
    { n: "H2 标题", fn: () => edLinePrefix("## ") },
    { n: "H3 标题", fn: () => edLinePrefix("### ") },
    { n: "引用块", fn: () => edLinePrefix("> ") },
    { n: "清除行格式", fn: () => edLinePrefix("") },
  ]);
  act("image").onclick = () => document.getElementById("edImgFile").click();
  document.getElementById("edImgFile").onchange = (e) => { edImage(e.target.files[0]); e.target.value = ""; };
  act("link").onclick = () => {
    const url = prompt("链接地址：", "https://");
    if (url) edWrap("[", "](" + url + ")", "添加链接描述");
  };
  act("insert").onclick = (e) => edMenu(e.currentTarget, [
    { n: "表格 3×3", fn: () => edInsert("\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n") },
    { n: "分隔线", fn: () => edInsert("\n---\n") },
    { n: "引用块", fn: () => edLinePrefix("> ") },
    { n: "当前日期", fn: () => edInsert(new Date().toLocaleDateString("zh-CN")) },
  ]);
  act("save").onclick = edExport;
  act("clear").onclick = () => edApply("clear");
  document.getElementById("edBase").onclick = () => { edBaseText = edTextEl().value; toast("已设为比对基线"); if (edTab === "diff") edRenderDiff(); };
  const at = document.getElementById("edAttach");
  try { at.checked = localStorage.getItem("aug-ed-attach") !== "0"; } catch (e2) {}
  at.onchange = () => { try { localStorage.setItem("aug-ed-attach", at.checked ? "1" : "0"); } catch (e3) {} };
  let want = localStorage.getItem("aug-ed-open");
  if (want == null) want = window.innerWidth > 860 ? "1" : "0";
  edOpen(want === "1");
}


/* ---------- API 文档面板 ---------- */
async function openApiDocs() {
  let registry = {}, switches = {};
  try { const c = await (await fetch('/api/config')).json(); registry = c.registry || {}; switches = c.models || {}; } catch (e) {}
  const enabled = Object.keys(registry).filter((id) => switches[id] !== false);
  const NL = String.fromCharCode(10);
  let gw = 'http://' + (location.hostname || '127.0.0.1') + ':3000';
  let rows, snip, noteText;
  if (window.IS_ANDROID) {
    try {
      const li = await (await fetch('/api/lan-info')).json();
      if (li.ip) gw = 'http://' + li.ip + ':' + li.port;
    } catch (e) {}
    rows = [
      ['base_url (OpenAI)', gw + '/v1'],
      ['api_key', '任意值（不校验）'],
      ['model · 智能体/ai-middle', 'deepseek-chat@middle, deepseek-reasoner@middle, csdn-agent-flash@phoenix, csdn-agent-pro@phoenix'],
      ['model · Dify', 'csdn-v3-0324@dify, csdn-qwen3-32b@dify, csdn-qwen3-32b-think@dify, csdn-qwen-plus@dify, csdn-v4-flash@dify'],
    ];
    snip = [
      '# OpenAI 兼容（chat completions，支持 stream）',
      'curl ' + gw + '/v1/chat/completions \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{\"model\":\"deepseek-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'",
    ].join(NL);
    noteText = '安卓版已内置 OpenAI 兼容网关：同一局域网内的电脑/软件把 base_url 指到上面的地址即可（手机 IP 随网络变化，以当前显示为准）。传文件解析：messages 里用多模态 content 携带文件内容（data:类型;base64），自动上传并走智能体文档分析。纯对话接口，不支持 tools 工具调用。';
  } else {
    rows = [
      ['base_url (OpenAI)', gw + '/v1'],
      ['base_url (Anthropic)', gw],
      ['base_url (Codex/responses)', gw + '/v1'],
      ['api_key', '任意值（网关默认不校验）'],
      ['model', enabled.join(', ') || '（无可用模型，检查网关与开关）'],
    ];
    snip = [
      '# OpenAI 兼容（chat completions）',
      'curl ' + gw + '/v1/chat/completions \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{\"model\":\"deepseek-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'",
      '',
      '# Anthropic 兼容（Claude Code 直连）',
      'export ANTHROPIC_BASE_URL=' + gw,
      'claude -p "你好" --model deepseek-chat',
      '',
      '# Codex（responses 协议，CODEX_HOME/config.toml）',
      '# model_provider.csdn.base_url = "' + gw + '/v1"',
    ].join(NL);
    noteText = '网关需已运行：node csdn-ai-server.js 3000（与网页服务同机）。csdn-* 快聊模型无工具能力，编码任务请用 deepseek-chat。';
  }
  const tb = document.getElementById('docsTable');
  tb.innerHTML = rows.map(([k, v]) =>
    '<tr><td class="k">' + esc(k) + '</td><td class="v">' + esc(v) + ' <button class="mini-copy" data-v="' + esc(v) + '">⧉</button></td></tr>'
  ).join('');
  tb.querySelectorAll('.mini-copy').forEach((b) => { b.onclick = () => copyText(b.dataset.v, '已复制'); });
  document.getElementById('docsSnip').textContent = snip;
  document.getElementById('docsCopyBtn').onclick = () => copyText(snip, '快速开始已复制');
  document.getElementById('docsNote').textContent = noteText;
  document.getElementById('docsMask').style.display = 'flex';
}
function closeApiDocs() { document.getElementById('docsMask').style.display = 'none'; }

/* ---------- Cookie 文件导出/导入 + 移动端抽屉 ---------- */
function initCookieFile() {
  if (window.IS_ANDROID) {
    mcpTransport = "http";
    const st = document.getElementById("mcpTransport"), mo = document.getElementById("mcpOs");
    if (st) {
      const a = st.querySelector('[data-t="stdio"]'), b = st.querySelector('[data-t="sse"]'), h = st.querySelector('[data-t="http"]');
      if (a) a.style.display = "none"; if (b) b.style.display = "none";
      if (h) { const so = st.querySelector("button.on"); if (so) so.classList.remove("on"); h.classList.add("on"); }
    }
    if (mo) mo.style.display = "none";
    const hd = document.getElementById("mcpHint");
    if (hd) hd.textContent = "局域网内的 Claude Code / 客户端直连手机 MCP（复制下面的 JSON 到客户端配置）。文件工具用 data_b64 传内容。";
  }
  fetch('/api/health').then((r) => r.json()).then((j) => {
    if (j && j.v) {
      const el = document.getElementById('cookieTip');
      if (el) { el.textContent = '● cookie · ' + j.v; el.title = 'App 版本 ' + j.v + '（看不到版本号 = 旧版安装包）'; }
    }
  }).catch((e) => {});
  const uidInp = document.getElementById('uidInput');
  if (uidInp) {
    fetch('/api/config').then((r) => r.json()).then((c) => { if (c.uid) uidInp.value = c.uid; }).catch((e) => {});
    uidInp.addEventListener("change", () => {
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: uidInp.value.trim() }) });
    });
  }
  document.getElementById('runDiagBtn').onclick = async () => {
    const out = document.getElementById('diagOut');
    out.style.display = 'block';
    out.textContent = '诊断中…（请求一次上游，约 5-15 秒）';
    try {
      const r = await fetch('/api/dbg?q=' + encodeURIComponent('你好'));
      out.textContent = await r.text();
    } catch (e) { out.textContent = '诊断请求失败：' + e.message; }
  };
  document.getElementById('exportCookieBtn').onclick = () => { location.href = '/api/auth/export'; };
  document.getElementById('importFileBtn').onclick = () => document.getElementById('cookieFile').click();
  document.getElementById('cookieFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const text = await f.text();
      const j = await (await fetch('/api/auth/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json();
      if (j.error) return toast('导入失败：' + j.error);
      toast('已导入 ' + j.count + ' 个 cookie' + (j.warn ? '（⚠ ' + j.warn + '）' : '，立即生效'));
      refreshCookieStatus();
    } catch (err) { toast('导入失败：' + err.message); }
    e.target.value = '';
  };
  const sb = document.getElementById('sidebar');
  document.getElementById('menuBtn').onclick = () => { sb.classList.add('open'); const m = document.getElementById('sbMask'); if (m) m.style.display = 'block'; };
  const closeSb = () => { sb.classList.remove('open'); const m = document.getElementById('sbMask'); if (m) m.style.display = 'none'; };
  const sc = document.getElementById('sideClose'); if (sc) sc.onclick = closeSb;
  const sm = document.getElementById('sbMask'); if (sm) sm.onclick = closeSb;
}
/* ---------- 移动端抽屉手势（左缘右滑开 / 左滑关，跟随手指） ---------- */
function initDrawerGesture() {
  const sb = document.getElementById("sidebar");
  const mask = document.getElementById("sbMask");
  if (!sb || !mask) return;
  let drag = null; // {x0,y0,axis,mode,base,cur}

  function drawerSet(open) {
    sb.classList.toggle("open", open);
    sb.style.transition = ""; sb.style.transform = "";
    mask.style.display = open ? "block" : "none";
  }

  // Pointer Events：真机触摸（pointerType=touch）与桌面鼠标拖拽统一覆盖
  document.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    const isOpen = sb.classList.contains("open");
    const onSidebar = sb.contains(e.target);
    if (!isOpen && e.clientX > 36) return;              // 仅左缘 36px 内右滑打开
    if (isOpen && !onSidebar && e.clientX > 36) return; // 遮罩区点击关闭（拖拽忽略）
    drag = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, axis: "", mode: isOpen ? "close" : "open", base: isOpen ? 0 : -sb.offsetWidth, cur: isOpen ? 0 : -sb.offsetWidth };
  });

  document.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.axis) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) drag.axis = "x";
      else if (Math.abs(dy) > 12) { drag = null; return; }
      else return;
    }
    let px = drag.base + dx;
    if (drag.mode === "open") px = Math.min(0, Math.max(-drag.base, px));
    else px = Math.min(0, Math.max(-sb.offsetWidth - 30, px));
    drag.cur = px;
    sb.style.transition = "none";
    sb.style.transform = "translateX(" + px + "px)";
    mask.style.display = px > -sb.offsetWidth * 0.5 ? "block" : "none";
  });

  function finish(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag; drag = null;
    const W = sb.offsetWidth;
    const openFinal = d.mode === "open" ? d.cur > -W * 0.6 : d.cur > -W * 0.4;
    drawerSet(openFinal);
  }
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

/* ---------- 设置面板（模型开关 + 全模态解析 MCP + 全局联网） ---------- */
let settingsData = null;
async function openSettings() {
  refreshCookieStatus(); refreshLanInfo();
  try { settingsData = await (await fetch("/api/config")).json(); } catch (e) { return toast("读取配置失败：" + e.message); }
  const list = document.getElementById("settingsList");
  const rows = [];
  for (const [id, info] of Object.entries(settingsData.registry || {})) {
    const on = settingsData.models[id] !== false;
    rows.push(`<div class="sw-row"><div><div class="label"><span class="g">${esc(info.group)}</span>${esc(info.label)}</div><div class="id">${esc(id)}</div></div>
      <label class="switch"><input type="checkbox" data-kind="model" data-id="${esc(id)}" ${on ? "checked" : ""}><span class="slider"></span></label></div>`);
  }
  list.innerHTML = rows.join("");
  // 全模态解析 MCP 卡片
  const mcpOn = settingsData.mcpEnabled !== false;
  document.getElementById("mcpToggle").checked = mcpOn;
  document.getElementById("mcpCard").style.opacity = mcpOn ? "1" : ".55";
  renderMcpSnippet();
  // 全局联网
  const ws = settingsData.webSearch || { web: true, api: false };
  document.getElementById("wsWebGlobal").checked = !!ws.web;
  document.getElementById("wsApiGlobal").checked = !!ws.api;
  document.getElementById("settingsMask").style.display = "flex";
}
function closeSettings() { document.getElementById("settingsMask").style.display = "none"; }
async function saveSettings() {
  if (!settingsData) return;
  const models = {};
  document.querySelectorAll("#settingsList input[data-kind=model]").forEach((cb) => { models[cb.dataset.id] = cb.checked; });
  const payload = {
    models,
    webSearch: {
      web: document.getElementById("wsWebGlobal").checked,
      api: document.getElementById("wsApiGlobal").checked,
    },
    mcpEnabled: document.getElementById("mcpToggle").checked,
  };
  try {
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    toast("已保存，网关/MCP 立即生效");
    closeSettings();
    loadModels();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function copyMcpConfig() {
  const text = document.getElementById("mcpCode").textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast("MCP 配置已复制");
  } catch (e) {
    // 剪贴板 API 不可用时的兜底
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
    toast("MCP 配置已复制（兜底模式）");
  }
}

/* ---------- 初始化 ---------- */
function switchMode(mode) {
  state.mode = mode;
  document.getElementById("sidebar").classList.remove("open");
  const m = document.getElementById("sbMask"); if (m) m.style.display = "none";
  syncTabs();
  const tmw = document.getElementById("toolModeWrap");
  if (tmw) tmw.style.display = (mode === "agent") ? "inline-flex" : "none";
  if (state.session && state.session.mode !== mode) state.session = null;
  renderStream();
}
function renderStream() {
  $("#stream").innerHTML = `<div id="welcome"><h1>CSDN 增强版</h1>
    <p class="sub">${{ chat: "对话模式 · ai-middle 直连", agent: "智能体模式 · DeepSeek V4 Flash/Pro", search: "AI 搜索 · Dify RAG 站内+联网检索" }[state.mode]}</p>
    <div id="quickActions"></div></div>`;
  renderQuickActions();
  if (state.session) {
    for (const m of state.session.messages) {
      if (m.role === "user") addUserMsg(m.display || m.content);
      else {
        const shell = addAssistantShell();
        if (m.think) { shell.thinkWrap.style.display = "block"; shell.thinkBody.textContent = m.think; }
        if (m.refs && m.refs.length) renderRefs(shell.refsEl, m.refs);
        shell.mdEl.innerHTML = md(m.content || "");
        if (m.content) addEdChips(shell.mdEl.closest(".bubble") || shell.mdEl.parentElement, m.content);
      }
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  setupSelMenu();
  loadModels();
  loadHistory();
  newSession("chat");

  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchMode(t.dataset.mode)));
  $("#newBtn").onclick = () => newSession();
  $("#sendBtn").onclick = () => send();
  $("#stopBtn").onclick = stopGen;
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("aug-theme", cur);
    $("#themeBtn").textContent = cur === "dark" ? "☀️" : "🌙";
  };
  $("#exportBtn").onclick = exportSession;
  $("#settingsBtn").onclick = openSettings;
  $("#saveSettingsBtn").onclick = saveSettings;
  $("#copyMcpBtn").onclick = copyMcpConfig;
  $("#apiDocsBtn").onclick = openApiDocs;
  $("#docsCloseBtn").onclick = closeApiDocs;
  $("#qr2Btn").onclick = () => {
    if (window.AndroidBridge && window.AndroidBridge.openLogin) window.AndroidBridge.openLogin();
    else startQr2();
  };
  $("#importToggleBtn").onclick = () => {
    const a = document.getElementById("importArea");
    a.style.display = a.style.display === "none" ? "block" : "none";
  };
  $("#importBtn").onclick = doImport;
  $("#logoutBtn").onclick = doLogout;
  document.querySelectorAll("#mcpTransport button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#mcpTransport button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on"); mcpTransport = b.dataset.t; renderMcpSnippet();
    };
  });
  document.querySelectorAll("#mcpOs button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#mcpOs button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on"); mcpOs = b.dataset.os; renderMcpSnippet();
    };
  });
  document.getElementById("docsMask").addEventListener("click", (e) => { if (e.target.id === "docsMask") closeApiDocs(); });
  document.getElementById("settingsMask").addEventListener("click", (e) => { if (e.target.id === "settingsMask") closeSettings(); });
  initCookieFile();
  initEdPanel();
  initDrawerGesture();
  $("#uploadBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = (e) => doUpload(e.target.files[0]);
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $("#input").addEventListener("input", autoGrow);
});
