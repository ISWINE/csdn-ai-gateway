/**
 * CSDN AI → DeepSeek/OpenAI 兼容 API 服务（纯 HTTP 直调，无浏览器）
 *
 * 启动： node csdn-ai-server.js [端口，默认3000] [可选API_KEY]
 * 兼容端点：
 *   POST /v1/chat/completions   （同 /chat/completions）
 *        - 支持 stream: true/false
 *        - reasoning 模型字段 reasoning_content（与 DeepSeek-R1 一致）
 *   GET  /v1/models
 *   POST /ask                   （旧简易格式，保留兼容）
 *   GET  /health
 *
 * 客户端示例（openai sdk）：
 *   const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "anything" });
 *   await client.chat.completions.create({ model: "deepseek-chat", messages: [...], stream: true });
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { ask, askRawResponse, streamDeltas, sanitizeText, salvageDSML, extractDSMLInvokes } = require("./csdn_ai_direct.js");
const { MODEL_MAP: PHOENIX_MODELS, streamAgentChat, agentChatComplete, uploadDoc } = require("./phoenix_agent.js");
// 只聊天的快模型：路由到 AI 搜索 Dify 通道（联网固定关闭，无工具调用能力）——Claude Code 纯问答加速档
const webuiChannels = require("./web-ui/lib/channels.js");
const nodeCrypto = require("crypto"); // 全局 crypto 是 WebCrypto（只有 randomUUID），md5 需要 node:crypto
const registry = require("./web-ui/lib/models-registry.js"); // 全部模型注册表 + 用户开关（热读取）
const DIFY_FAST_MODELS = { "csdn-v3-0324": "6", "csdn-qwen3-32b": "14", "csdn-qwen3-32b-think": "15", "csdn-qwen-plus": "2", "csdn-v4-flash": "3" };

const PORT = Number(process.argv[2]) || 3000;
const API_KEY = process.argv[3] || process.env.CSDN_API_KEY || ""; // 设置后强制 Bearer 校验

function checkAuth(req) {
  if (!API_KEY) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${API_KEY}` || req.headers["x-api-key"] === API_KEY; // Anthropic 客户端用 x-api-key
}

function chatId() { return "chatcmpl-" + crypto.randomUUID(); }

/** messages -> prompt：支持多轮、system、assistant.tool_calls、role:"tool"，清洗历史防回灌 */
// 提示词极简版（2026-08 重构）：DSML 是 CSDN 后端模型的原生工具格式（Roo/Cline 风格），
// 与其用大段禁令逼它改学 <tool_call> JSON，不如让 DSML 作为第一协议、<tool_call> 作备用。
const COMMON_TAIL =
  "【输出格式】输出显示在终端里，不渲染 Markdown 样式与 LaTeX：数学关系用纯文本描述（例如：前10项为 0、1、1、2、3）。" +
  "不要在正文输出 <previous_action>/<action_result>/<continue_instruction>/[系统] 这类系统内部记录标记，输出它们没有任何真实效果。";

const BASE_RULES =
  "直接以文本形式回答用户，代码放在完整 Markdown 代码块中。" + COMMON_TAIL;

const TOOL_RULES =
  "需要执行操作时，调用下方列出的真实工具（会真正执行并回传结果），调用格式：" +
  '<tool_call>{"name":"工具名","arguments":{参数}}</tool_call>\n' +
  "工具名和参数名必须严格使用下方列表里的名字（禁止编造 exec_command 等未列出的工具名）。写文件优先用 write_file 工具。" +
  "工具完全可用，不要声称环境不允许。多步任务：每步实际发起调用并等结果，完成后才给用户最终总结；已执行过的操作不要重做。" +
  "多文件项目必须逐个用工具写文件（每个 tool_call 只写一个文件），禁止在正文里输出项目代码。" +
  "写文件用相对当前目录的路径（用户指定绝对路径除外），禁止 ~ 开头路径。" + COMMON_TAIL;


// Agent 停止检测：模型进入"规划/探索"模式后只说了打算就停
function isAgentStop(content) {
  const t = (content || "").trim();
  if (!t) return true;
  if (t.length >= 150) return false;
  if (/```/.test(t)) return false; // 有代码块说明真的输出了成果
  return true;
}

/** 「宣而不做」检测：带工具场景下，模型说要执行动作但既没发调用也没给成果 */
function isAnnouncedOnly(content) {
  const t = (content || "").trim();
  if (!t || t.length > 600) return false;
  if (/```/.test(t)) return false;
  if (/已完成|结果如下|运行结果|输出如下|输出：/.test(t)) return false; // 已交付成果
  if (/你可以|建议你|如需|你可以自己/.test(t)) return false;             // 给用户的建议，不是自己的计划
  const firstPersonPlan = /(我(先|再|来|将|会|要去?)|让我|接下来|然后|下面|先看|先查|先创建|先读取|先分析)/.test(t)
    && /(读取|写入|保存|运行|修改|查看|分析|检查|排查|创建|生成|继续|搜索|打开|确认|验证|安装|编写|新建|执行)/.test(t);
  const hasIntent = /(现在|接下来|然后|即将|马上|一次|下面|先把|再)/.test(t);
  const hasAction = /(创建|写入|保存|运行|修改|删除|生成|安装|建齐|执行|读取|检查|确认|查看|验证|分析|编写|新建|搜索)/.test(t);
  return firstPersonPlan || (hasIntent && hasAction);
}

/** 宽松版「宣而不做」：有工具历史的短收尾文本，含意图/动作词但无交付标记 → 大概率半途宣告（仅用于有工具且历史含工具结果的场景） */
function isAnnouncedLoose(content) {
  const t = (content || "").trim();
  if (!t || t.length > 300) return false;
  if (/```/.test(t)) return false;
  if (/已完成|结果如下|运行结果|输出如下|输出[:：]|已创建|已写入|已生成|已修复|已更新|已删除/.test(t)) return false;
  return /(我|并|先|再|然后|接下来|马上|即将)/.test(t)
    && /(创建|写入|保存|运行|修改|删除|生成|安装|执行|读取|检查|确认|查看|验证|分析|编写|新建|搜索|修复|重建|更新|继续)/.test(t);
}

/** 规划式停止检测（仅限无工具场景）：短答 + Agent 式意图措辞才算 */
function isPlanStopStyle(content) {
  const t = (content || "").trim();
  if (!t) return true; // 完全空回复必须重试
  if (t.length >= 150 || /```/.test(t)) return false;
  return /(我先|让我先|我来先|接下来我|先查看|先确认|先看下|查看.{0,12}(目录|文件)|探索|规划|实现方案|列出.{0,8}文件)/.test(t);
}

const ANTI_AGENT = [
  "【强制要求】你没有文件系统，没有任何工具，不能执行任何操作或探索。禁止规划流程、禁止说\"我先查看/让我先\"之类的话。必须在本条回复中直接给出最终完整成果；如涉及代码，完整代码全部放在代码块中输出。",
  "【最高优先级】立即跳过一切计划与说明，不要再描述你将做什么。现在就输出最终成果本身：内容与代码一次性完整给出，代码放代码块。",
];

const TOOL_FMT_TAIL = "\n（执行操作的方式：输出 <tool_call>{\"name\":\"工具名\",\"arguments\":{...}}</tool_call>，工具名严格取自可用工具列表。）";

// 工具拒绝场景的升级重试：模型声称"环境不允许"却没发起调用
const TOOL_ESCALATION = [
  "【重要更正】工具是真实可用的！你上一条回复错误地认为不能调用工具。请立即输出 <tool_call>{\"name\":\"工具名\",\"arguments\":{参数}}</tool_call> 来完成用户要求的操作。不要让用户手动保存或操作。",
  "【最高优先级】只输出一个 <tool_call>{\"name\":\"...\",\"arguments\":{...}}</tool_call> 块，不要输出任何其他内容。",
];

function toolEscalate(prompt, n, tail = "") {
  return TOOL_ESCALATION[Math.min(n, TOOL_ESCALATION.length) - 1] + (tail || "") + "\n\n" + prompt + TOOL_FMT_TAIL;
}

// 最后一步升级：工具全部执行完却没给用户总结就停了
const SUMMARY_ESCALATION = [
  "【最后一步】所有工具都已执行完毕，但用户还没看到任何结果。立即停止发起新的 tool_call，改为直接面向用户输出最终总结：说明完成了什么，并原样贴出关键的真实执行输出（如命令的打印结果）。不要让用户自己去翻文件。",
  "立即输出最终总结文字（必须包含真实运行输出的原文），不要再调用任何工具。",
];
function summaryEscalate(prompt, n) {
  return SUMMARY_ESCALATION[Math.min(n, SUMMARY_ESCALATION.length) - 1] + "\n\n" + prompt;
}

// 续跑升级：模型只宣布打算（"我继续读取…"）却没发调用也没给最终答案时使用
const CONTINUE_ESCALATION = [
  "【系统】你上一条回复只有计划没有行动。你现在的下一个回复必须以 <tool_call> 开头（在此 tool_call 之前不允许有任何文字），用它创建任务需要的下一个具体文件或执行下一个具体命令；除这一个 <tool_call> 外不得输出任何其他内容。",
  "【最高优先级】现在就行动：输出一个 <tool_call> 块继续任务，或给出最终完整回答。二者必选其一，禁止空谈计划。",
  "【最后通牒】你的回复不允许只包含计划或说明，也不允许把整个项目的代码贴在正文里。只允许两种内容之一：1) 一个 <tool_call>{\"name\":\"...\",\"arguments\":{...}} 块（写文件/执行命令）；2) 纯文字类任务的最终成果。任何\"接下来我将…\"式的话都算失败。",
];
function continueEscalate(prompt, n, tail = "") {
  return CONTINUE_ESCALATION[Math.min(n, CONTINUE_ESCALATION.length) - 1] + (tail || "") + "\n\n" + prompt;
}

function escalatePrompt(prompt, n, tail = "") {
  const extra = ANTI_AGENT[Math.min(n, ANTI_AGENT.length) - 1];
  return extra + (tail || "") + "\n\n" + prompt + (n >= 2 ? "\n\n立即直接输出完整成果。" : "");
}

/** 内容规范化：兼容 string 与 Anthropic 式块数组（[{type:"text",text:...}]） */
function normContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map(b => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") ? b.text : "").filter(Boolean).join("\n");
  }
  if (c && typeof c === "object" && typeof c.text === "string") return c.text;
  return "";
}

function messagesToPrompt(messages, hasTools = false) {
  const clean = (s) => normContent(s).replace(/<[\uFF5C|]+DSML[\s\S]*?(<\/[\uFF5C|]+(?:DSML[\uFF5C|]*)*DSML[^>\n]*>|$)/g, "");
  const parts = [hasTools ? TOOL_RULES : BASE_RULES];
  for (const m of messages || []) {
    if (m.role === "system") {
      parts.push("【系统指令】" + clean(m.content));
    } else if (m.role === "user") {
      parts.push("用户: " + clean(m.content));
    } else if (m.role === "assistant") {
      let t = clean(m.content || "");
      if (m.tool_calls?.length) {
        const calls = m.tool_calls.map(tc => {
          let a = tc.function?.arguments || "";
          try {
            const o = JSON.parse(a);
            a = Object.entries(o).map(([k, v]) => {
              const vs = String(v);
              return vs.length > 60 ? `${k}=（${vs.length}字内容，已写入）` : `${k}=${vs}`;
            }).join(", ");
          } catch {}
          return `${tc.function?.name}(${a})`;
        }).join("; ");
        t += (t ? "\n" : "") + `<previous_action>${calls}</previous_action>`;
      }
      parts.push("助手: " + t);
    } else if (m.role === "tool") {
      let c = normContent(m.content);
      // 超长工具结果截断（保留首尾），防止上下文爆炸导致思考占满输出
      if (c.length > 4000) c = c.slice(0, 2800) + "\n…[中间内容省略 " + (c.length - 3600) + " 字]…\n" + c.slice(-800);
      parts.push(`<action_result tool="${m.name || m.tool_call_id || ""}">\n${clean(c)}\n</action_result>`);
    }
  }
  // 续跑指令只注入一次（在最后一条工具结果之后），避免历史里多份重复提示诱发复读
  if ((messages || []).some(m => m.role === "tool")) {
    parts.push("<continue_instruction>以上工具均已执行完毕。若工具结果已能满足用户请求，直接输出最终总结回答用户（不要再调用工具）；确实还有未完成的步骤时，才按前述格式发起下一个工具调用。</continue_instruction>");
  }
  return parts.join("\n") + "\n助手:";
}

/** 构造工具调用协议的系统提示 */
function toolsSystemPrompt(tools) {
  // Hermes 标准模板（vLLM 同款）：工具 schema 以 JSON 数组注入，模型用 <tool_call> 回应
  const list = (tools || []).map((t) => {
    const f = t.function || t;
    return { type: "function", function: { name: f.name, description: f.description || "", parameters: (typeof f.parameters === "string" ? JSON.parse(f.parameters || "{}") : (f.parameters || { type: "object", properties: {} })) } };
  });
  const DQ = String.fromCharCode(34);
  const L = [];
  L.push("You are a function calling AI agent with access to the tools below. 工具执行结果会以 <action_result> 标签回传给你，基于真实结果继续工作，严禁编造执行结果。");
  L.push("");
  L.push("<tools>");
  L.push(JSON.stringify(list));
  L.push("</tools>");
  L.push("");
  L.push("需要调用工具时，仅输出一行（不要代码块、不要解释、不要编造结果）：");
  L.push("<tool_call>{" + DQ + "name" + DQ + ": " + DQ + "工具名" + DQ + ", " + DQ + "arguments" + DQ + ": {参数}}</tool_call>");
  L.push("工具名与参数名严格取自 <tools>。可连续输出多个 <tool_call> 并行调用。收到 <action_result> 后，若结果已能满足用户请求，立即输出最终中文回答（不要再调用工具）。不要使用 DSML 或其他标记格式。");
  return L.join("\n");
}

/** 从输出中解析 <tool_call> 块（容忍 JSON 损伤：尾逗号/提取 arguments 对象/回退 cmd 字段） */
function extractToolCalls(text) {
  const calls = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  // 流末未闭合容错：截取最后一个 <tool_call> 到文末
  if (text.includes("<tool_call>") && !/<\/tool_call>\s*$/.test(text)) {
    text = text + "</tool_call>";
  }
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1].trim();
    let j = null;
    try { j = JSON.parse(inner); } catch {}
    if (!j) { try { j = JSON.parse(inner.replace(/,\s*([}\]])/g, "$1")); } catch {} }
    if (!j) {
      const name = (inner.match(/"name"\s*:\s*"([^"]*)"/) || [])[1];
      const am = inner.match(/"arguments"\s*:\s*(\{[\s\S]*\})/);
      if (name && am) { try { j = { name, arguments: JSON.parse(am[1]) }; } catch {} }
    }
    if (!j) {
      const name = (inner.match(/"name"\s*:\s*"([^"]*)"/) || [])[1];
      const cm = inner.match(/"(?:cmd|command)"\s*:\s*"([\s\S]*)"/);
      if (name && cm) {
        try { j = { name, arguments: { cmd: JSON.parse('"' + cm[1] + '"') } }; }
        catch { j = { name, arguments: { cmd: cm[1] } }; }
      }
    }
    if (!j) continue;
    if (Array.isArray(j)) calls.push(...j);
    else if (j && typeof j === "object") calls.push(j);
  }
  return calls;
}

function safeParseArgs(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

function toOpenAIToolCalls(calls) {
  return calls.map((c, i) => ({
    id: `call_${Date.now().toString(36)}_${i}`,
    type: "function",
    function: {
      name: c.name || (c.function && c.function.name) || "unknown",
      arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? c.parameters ?? {}),
    },
  }));
}

/** 工具调用统一修复：名称模糊映射到客户端真实工具（exec_command→shell 等）+ 参数形状矫正 */
function fixupCalls(calls, tools) {
  const invokes = (calls || []).map((c) => ({
    name: c.name || (c.function && c.function.name) || "",
    params: typeof c.arguments === "string" ? safeParseArgs(c.arguments) : (c.arguments ?? {}),
  })).filter((c) => c.name);
  if (!invokes.length) return [];
  const mapped = mapDSMLToClient(invokes, tools);
  if (mapped.length >= invokes.length) return mapped;
  const out = [...mapped];
  for (let i = mapped.length; i < invokes.length; i++) {
    out.push({ name: invokes[i].name, arguments: JSON.stringify(invokes[i].params ?? {}) });
  }
  return out;
}

function estimateTokens(s) { return Math.ceil((s || "").length / 2); }

/** 流式增量 DSML 过滤器：块内内容不再丢弃，而是抢救成 Markdown 代码块 */
function makeDSMLFilter(emit, onBlock = null) {
  let pending = "";      // normal 模式下未收全的标记尾巴
  let inBlock = false;
  let blockAcc = "";     // DSML 块累积（含起始标记）
  const stripStray = (s) => s.replace(/<\/?[\uFF5C|][^>\n]{0,120}>/g, "");
  function feed(chunk) {
    let s = pending + chunk;
    pending = "";
    let guard = 0;
    while (s.length && guard++ < 100000) {
      if (inBlock) {
        // 块结束：invoke 或外层 tool_calls 的闭合（容忍 DSML 字样插在标签中段）
        const close = s.match(/<\/[\uFF5C|]+(?:DSML[\uFF5C|]*)*(?:invoke|tool_calls)[^>\n]*>/);
        if (!close) { blockAcc += s; s = ""; continue; }
        blockAcc += s.slice(0, close.index + close[0].length);
        s = s.slice(close.index + close[0].length);
        inBlock = false;
        const replacement = onBlock ? onBlock(blockAcc) : salvageDSML(blockAcc);
        if (replacement) emit(replacement);   // 抢救：转成可读代码块（或映射为工具调用）
        blockAcc = "";
        continue;
      }
      const idx = s.search(/<[\uFF5C|]/);
      if (idx === -1) {
        if (s.endsWith("<")) { const out = stripStray(s.slice(0, -1)); pending = "<"; if (out) emit(out); }
        else { const out = stripStray(s); if (out) emit(out); }
        return;
      }
      const out = stripStray(s.slice(0, idx));
      if (out) emit(out);
      s = s.slice(idx);
      const gt = s.indexOf(">");
      if (gt === -1) { pending = s; return; }
      const token = s.slice(0, gt + 1);
      s = s.slice(gt + 1);
      if (/^<[\uFF5C|]+DSML/.test(token)) { inBlock = true; blockAcc = token; continue; }
      // 游离的特殊标签：静默丢弃
    }
  }
  function flush() {
    if (inBlock && blockAcc) {
      const replacement = onBlock ? onBlock(blockAcc) : salvageDSML(blockAcc);
      if (replacement) emit(replacement);
    }
    else if (pending) { const out = stripStray(pending); if (out) emit(out); }
    pending = ""; inBlock = false; blockAcc = "";
  }
  return { feed, flush };
}

/** CSDN agent 外壳的 DSML 工具名清单（实测捕获 + Cline 系推断）→ 客户端工具类别 */
const CSDN_TOOL_ALIASES = [
  { re: /^(exec_command|execute_command|run_command|terminal)$/i, kind: "exec" },
  { re: /^(editor_write|write_to_file|write_file|edit_new_file|create_file)$/i, kind: "write" },
  { re: /^(read_file|view_file|open_file|read)$/i, kind: "read" },
  { re: /^(search_files|grep_search|glob_search|search)$/i, kind: "search" },
  { re: /^(list_files|list_dir|list_directory)$/i, kind: "list" },
  { re: /^(edit_markdown|replace_in_file|edit_file|patch_file)$/i, kind: "edit" },
];

/** attempt_completion 类交付工具：params.result 就是给用户的最终答案，不是工具调用 */
function extractCompletionResult(invokes) {
  for (const inv of invokes) {
    if (/^(attempt_completion|complete_task|finish_task)$/i.test(inv.name || "")) {
      const p = inv.params || {};
      const r = p.result || p.content || p.text;
      if (r) return String(r);
    }
  }
  return null;
}

/**
 * DSML 原生调用 → 客户端工具桥接：
 * 模型有时不走 <tool_call> 协议，而是输出原生 DSML（如写入编辑器）。
 * 这里按语义把 DSML 调用映射到客户端提供的真实工具上。
 */
function mapDSMLToClient(invokes, tools) {
  const out = [];
  for (const inv of invokes) {
    const lname = (inv.name || "").toLowerCase().trim();
    const fname = (t) => ((t.function || t).name || "").toLowerCase();
    const fdesc = (t) => ((t.function || t).description || "").toLowerCase();
    let target = tools.find((t) => fname(t) === lname) || null; // 提示词已要求模型用客户端工具名发起 DSML 调用 → 先精确匹配
    if (!target) {
      const alias = CSDN_TOOL_ALIASES.find((a) => a.re.test(inv.name || ""));
      const kind = alias ? alias.kind
        : /write|save|create|file|写|保存|创建/i.test(lname) ? "write"
        : /bash|shell|exec|command|run|terminal/i.test(lname) ? "exec"
        : /read|open|glob|grep|读|搜索/i.test(lname) ? "read" : null;
      if (kind === "exec") target = tools.find(t => /bash|exec|command|terminal/.test(fname(t))) || tools.find(t => /execut|command/.test(fdesc(t)));
      else if (kind === "write") target = tools.find(t => /write/.test(fname(t))) || tools.find(t => /edit/.test(fname(t))) || tools.find(t => /create|save/.test(fname(t))) || tools.find(t => /write|file/.test(fdesc(t)));
      else if (kind === "read") target = tools.find(t => /read|open/.test(fname(t))) || tools.find(t => /read/.test(fdesc(t)));
      else if (kind === "search") target = tools.find(t => /grep|glob|search/.test(fname(t))) || tools.find(t => /search/.test(fdesc(t)));
      else if (kind === "list") target = tools.find(t => /glob|list|tree/.test(fname(t))) || tools.find(t => /bash|exec|command|terminal/.test(fname(t)));
      else if (kind === "edit") target = tools.find(t => /edit/.test(fname(t))) || tools.find(t => /write/.test(fname(t)));
      if (!target && kind) {
        // 兜底：有大内容参数 → 找带 content/file 的工具
        const big = Object.values(inv.params).some(v => typeof v === "string" && v.length > 200);
        target = big ? tools.find(t => /write|file|content/i.test(fname(t) + fdesc(t))) : null;
      }
      // read/search/list 类在"只有 shell"的客户端（codex）上转成等价 PowerShell 命令
      if (!target && (kind === "read" || kind === "search" || kind === "list")) {
        const shellTool = tools.find(t => /bash|shell|exec|command|terminal/.test(fname(t)));
        if (shellTool) {
          const f = shellTool.function || shellTool;
          const val = Object.values(inv.params).find(v => typeof v === "string" && v.trim()) || ".";
          const q = String(val).replace(/'/g, "''");
          const cmd = kind === "read" ? `Get-Content -Raw -Encoding UTF8 '${q}'`
            : kind === "search" ? `Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern '${q}' | Select-Object -First 40`
            : `Get-ChildItem -Force '${q}' | Select-Object Name, Length`;
          const argvLike = f.parameters && f.parameters.properties && f.parameters.properties.command
            && f.parameters.properties.command.type === "array";
          const shellArgs = argvLike
            ? { command: ["powershell", "-NoProfile", "-Command", cmd] }
            : { command: cmd };
          return out.concat([{ name: f.name, arguments: JSON.stringify(shellArgs) }]);
        }
      }
    }
    if (!target) continue;
    const f = target.function || target;
    const props = (f.parameters && f.parameters.properties) || {};
    const required = (f.parameters && f.parameters.required) || [];
    const args = {};
    const entries = Object.entries(inv.params);
    for (const [pk, pv] of entries) {
      let key = Object.keys(props).find(k =>
        k.toLowerCase().includes(pk.toLowerCase()) || pk.toLowerCase().includes(k.toLowerCase()));
      if (!key && pv.length > 200) key = Object.keys(props).find(k => /content|body|text|code|new_string/i.test(k));
      if (!key) key = Object.keys(props).find(k => !(k in args));
      if (key) args[key] = pv;
    }
    for (const r of required) if (!(r in args)) args[r] = "";
    // 单参数工具直接塞值
    if (!entries.length && Object.keys(props).length === 1) args[Object.keys(props)[0]] = "";
    // codex 的 update_plan 是严格 schema：explanation:string + plan:[{step,status:pending|in_progress|completed}]。
    // 模型实测把计划项数组塞进 explanation、漏掉 plan → 必须在此重建，否则 codex 解析必炸且模型无法自纠
    if (/^update_plan$/i.test(f.name)) {
      const raw = (Array.isArray(args.plan) && args.plan.some((it) => it && (typeof it !== "string" || String(it).trim())))
        ? args.plan
        : (Array.isArray(args.explanation) ? args.explanation : []);
      const plan = raw.map((it) => {
        if (typeof it === "string") return { step: it.trim(), status: "pending" };
        const o = it || {};
        const step = String(o.step || o.name || o.text || o.title || "").trim();
        const st = String(o.status || "pending").toLowerCase();
        if (/^(inprogress|in_progress|doing|active|进行中)$/.test(st)) return { step, status: "in_progress" };
        if (/^(completed|complete|done|finished|已完成)$/.test(st)) return { step, status: "completed" };
        return { step, status: "pending" };
      }).filter((it) => it.step);
      if (!plan.length) continue; // 重建不出有效计划项 → 丢弃这次 update_plan，防止畸形参数死循环
      args.plan = plan;
      if (typeof args.explanation !== "string" || !args.explanation.trim()) args.explanation = "计划更新";
    }
    // 参数形状按 schema 双向矫正：codex 0.150+ 的 shell command 声明为 string（整行命令），
    // 收到数组必须拼回一行；声明为 array 的（旧版 shell/其他工具）才做包装
    for (const k of Object.keys(args)) {
      const pt = props[k] && props[k].type;
      if ((pt === "string" || (!pt && k === "command")) && Array.isArray(args[k])) {
        const arr = args[k].map((s) => String(s));
        args[k] = arr.length === 1
          ? arr[0]
          : arr.map((s) => (/\s/.test(s) ? '"' + s.replace(/"/g, "'") + '"' : s)).join(" ");
      } else if (pt === "array" && typeof args[k] === "string") {
        args[k] = /^shell$/i.test(f.name) && k === "command"
          ? ["powershell", "-NoProfile", "-Command", args[k]]
          : [args[k]];
      }
    }
    out.push({ name: f.name, arguments: JSON.stringify(args) });
  }
  return out;
}

/** 流式工具调用捕获器：拦截 <tool_call>{json}</tool_call>，其余文本正常放行 */
function makeToolCallFilter(emitContent) {
  const OPEN = "<tool_call>", CLOSE = "</tool_call>";
  let buf = "", inBlock = false;
  const calls = [];
  function process() {
    while (true) {
      if (inBlock) {
        const e = buf.indexOf(CLOSE);
        if (e === -1) return; // 等 JSON 闭合
        const inner = buf.slice(0, e);
        buf = buf.slice(e + CLOSE.length);
        inBlock = false;
        try {
          const j = JSON.parse(inner.trim());
          Array.isArray(j) ? calls.push(...j) : calls.push(j);
        } catch {}
        continue;
      }
      const o = buf.indexOf(OPEN);
      if (o === -1) {
        // 扣留可能是 "<tool_call>" 前缀的尾巴
        let hold = 0;
        for (let k = Math.min(buf.length, OPEN.length - 1); k > 0; k--) {
          if (buf.endsWith(OPEN.slice(0, k))) { hold = k; break; }
        }
        const safe = buf.slice(0, buf.length - hold);
        if (safe) emitContent(safe);
        buf = buf.slice(buf.length - hold);
        return;
      }
      if (o > 0) { emitContent(buf.slice(0, o)); buf = buf.slice(o); }
      inBlock = true;
      buf = buf.slice(OPEN.length);
    }
  }
  return {
    feed(t) { buf += t; process(); },
    flush() { if (!inBlock && buf) emitContent(buf); buf = ""; },
    calls,
  };
}

/** 叙述式调用捕获：模型模仿历史格式输出「[助手发起了工具调用] Name({...})」时，转为真实调用并剔除虚构结果 */
function makeNarratedCallFilter(emitContent, onCall) {
  let buf = "";
  function handleLine(line) {
    const m = line.match(/\[助手发起了工具调用\]\s*([A-Za-z_][\w]*)\(([\s\S]*)\)\s*$/);
    if (m) { onCall(m[1], m[2].trim()); return; }
    const m2 = line.match(/<previous_action>\s*([A-Za-z_][\w]*)\((.*)\)<\/previous_action>\s*$/);
    if (m2) { onCall(m2[1], m2[2].trim()); return; }
    if (/\[工具 [^\]]*的执行结果\]/.test(line)) return;   // 虚构的结果行
    if (/^\s*\[系统\]/.test(line)) return;                 // 续跑提示回显
    if (/<action_result/.test(line) || /<continue_instruction>/.test(line)) return;
    const cleaned = line
      .replace(/\[助手发起了工具调用\][^\n]*/g, "")
      .replace(/\[工具 [^\]]*的执行结果\][^\n]*/g, "")
      .replace(/<\/?action_result[^>]*>/g, "")
      .replace(/<\/?continue_instruction>/g, "")
      .replace(/<\/?previous_action[^>]*>/g, "");
    if (cleaned) emitContent(cleaned + "\n");
  }
  return {
    feed(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    },
    flush() { if (buf.trim()) handleLine(buf); buf = ""; },
  };
}

/** 附件桥通用块处理（双协议共用）：识别 document/image/image_url 部件并上传
 *  返回 null（非附件）或 { marker, docId?, phoenix? }：docId→Dify 视觉/文档流；phoenix→[[文件:]] 文档链路 */
const ATT_EXT_BY_MT = { markdown: "md", "x-markdown": "md", plain: "txt", csv: "csv", html: "html", json: "json", pdf: "pdf", "msword": "doc", "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "vnd.ms-excel": "xls" };
async function bridgeAttachmentPart(b, label) {
  // Anthropic document 块
  if (b.type === "document" && b.source && b.source.type === "base64") {
    const mt = (b.source.media_type || "").toLowerCase();
    const title = b.title || "附件";
    // 文本类 ≤30KB：直接返回内联文本（任何模型都能读，无需上传）
    if (mt.startsWith("text/") || mt === "application/json" || mt === "application/csv") {
      let content = Buffer.from(b.source.data, "base64").toString("utf8");
      if (content.length > 30000) content = content.slice(0, 30000) + "\n…[附件过长已截断，其余内容已交由文档分析]";
      const big = Buffer.from(b.source.data, "base64").toString("utf8").length > 30000;
      if (!big) return { marker: `[附件「${title}」内容开始]\n${content}\n[附件内容结束]` };
    }
    const ext = ATT_EXT_BY_MT[mt.split("/")[1]] || "txt";
    const tmp = path.join(os.tmpdir(), `zcode-att-${Date.now()}-${label}.${ext}`);
    fs.writeFileSync(tmp, Buffer.from(b.source.data, "base64"));
    const up = await webuiChannels.uploadSearchDoc(fs.readFileSync(tmp), `${title}.${ext}`.replace(/^\./, ""));
    try { fs.unlinkSync(tmp); } catch {}
    console.log(`[附件桥:${label}] 文档已上传 docId:`, up.docId);
    return { docId: up.docId, marker: `[用户上传了文档「${title}」，已交由文档分析，请依据其内容回答。]` };
  }
  // Anthropic image 块 / OpenAI image_url 部件 / OpenAI file 部件（data: URL）
  let imgBuf = null, ext = "png";
  if (b.type === "image" && b.source && b.source.type === "base64") {
    imgBuf = Buffer.from(b.source.data, "base64");
    ext = ((b.source.media_type || "").split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
  } else if (b.type === "image" && b.source && b.source.type === "url" && b.source.url) {
    // URL 型图片：抓取后转传
    try {
      const rr = await fetch(b.source.url, { signal: AbortSignal.timeout(30000) });
      if (rr.ok) { imgBuf = Buffer.from(await rr.arrayBuffer()); ext = ((b.source.url.split(".").pop() || "png").split("?")[0].replace(/[^a-z0-9]/gi, "") || "png").slice(0, 5); }
    } catch {}
  } else if (b.type === "image_url" && b.image_url && /^data:image\//.test(b.image_url.url || "")) {
    const m = b.image_url.url.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/);
    if (m) { imgBuf = Buffer.from(m[2], "base64"); ext = (m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, ""); }
  }
  if (imgBuf) {
    const tmp = path.join(os.tmpdir(), `zcode-img-${Date.now()}-${label}.${ext}`);
    fs.writeFileSync(tmp, imgBuf);
    const up = await webuiChannels.uploadSearchDoc(imgBuf, `zcode-img-${label}.${ext}`);
    try { fs.unlinkSync(tmp); } catch {}
    console.log(`[附件桥:${label}] 图片已上传 docId:`, up.docId);
    return { docId: up.docId, marker: "[用户上传了一张图片，已交由视觉模型分析，请依据图片内容回答。]" };
  }
  // OpenAI file 部件（部分 IDE 传 PDF/文档用这个）：file.file_data 为 data:URL
  if (b.type === "file" && b.file && typeof b.file.file_data === "string" && /^data:[^;]+;base64,/.test(b.file.file_data)) {
    const m = b.file.file_data.match(/^data:([^;]+);base64,([\s\S]+)$/);
    if (m) {
      const mt = m[1].toLowerCase();
      const title = (b.file.filename || "附件").replace(/[\\/:*?"<>|]/g, "_");
      const extFromName = (title.split(".").pop() || "").toLowerCase();
      // 文本类小文件：内联
      const buf = Buffer.from(m[2], "base64");
      if ((mt.startsWith("text/") || mt === "application/json") && buf.length <= 30000) {
        return { marker: `[附件「${title}」内容开始]\n${buf.toString("utf8")}\n[附件内容结束]` };
      }
      const ext2 = ATT_EXT_BY_MT[mt.split("/")[1]] || (extFromName && extFromName.length <= 5 ? extFromName : "bin");
      const up = await webuiChannels.uploadSearchDoc(buf, `${title}.${ext2}`.replace(/\.${ext2}\./, "."));
      console.log(`[附件桥:${label}] file 部件已上传 docId:`, up.docId);
      return { docId: up.docId, marker: `[用户上传了文件「${title}」，已交由文档分析，请依据其内容回答。]` };
    }
  }
  return null;
}

async function handleChat(req, res, body) {
  let model = body.model || "deepseek-chat";
  const stream = !!body.stream;
  // 用户开关：停用的模型直接明确报错（IDE 可见原因，而不是静默失败）
  if (!registry.isModelEnabled(model)) {
    return sendJSON(res, 404, { error: { message: `模型「${model}」已在 web 设置面板停用（http://localhost:3010 设置页可重新开启）`, type: "model_disabled" } });
  }
  // 只聊天快模型：Dify 通道直路由（无工具能力，tools 参数忽略；联网固定关）
  if (DIFY_FAST_MODELS[model]) return handleDifyChat(req, res, body, model, stream);
  // 附件桥（OpenAI 线协议直连的 IDE 在此进入；/v1/messages 已在自身入口桥接）：
  // 扫描全部消息的 content 部件，图片/文档 → Dify 或 phoenix，并自动切到能读附件的模型
  let attDocId = "", attPhoenix = false;
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (let bi = 0; bi < m.content.length; bi++) {
      const b = m.content[bi];
      if (!b || typeof b !== "object" || b.type === "text" || b.type === "tool_call") continue;
      const r = await bridgeAttachmentPart(b, "chat").catch((e) => ({ marker: "[附件处理失败: " + String(e.message || e).slice(0, 80) + "]" }));
      if (r) {
        m.content[bi] = { type: "text", text: r.marker };
        if (r.docId) attDocId = r.docId; else if (r.phoenix) attPhoenix = true;
      }
    }
  }
  if (attDocId) {
    model = DIFY_FAST_MODELS[model] ? model : "csdn-v4-flash";
    body.model = model;
    body.docIds = attDocId;
    body.tools = undefined;
    return handleDifyChat(req, res, body, model, stream);
  }
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  // phoenix agent-chat 通道：csdn-agent-flash/pro，多轮质量与可靠性最好；带工具的请求仍走 ai-middle
  // 例外：带 [[文件:]] 附件标记的请求必须走 phoenix（唯一能读文档的通道），工具丢弃
  const hasFileMarker = (body.messages || []).some((m) => typeof m.content === "string" && m.content.includes("[[文件:"));
  const phoenixModel = (attPhoenix || hasFileMarker || !hasTools) ? PHOENIX_MODELS[model] : null;
  if (phoenixModel) return handlePhoenixChat(req, res, body, model, phoenixModel, stream);
  // ai-middle 通道永远走思考模式（think:false 通道常年限流）
  let prompt = messagesToPrompt(body.messages, false); // 工具约定由 toolsSystemPrompt(Hermes) 全权负责，避免双规则打架
  if (hasTools) {
    prompt = toolsSystemPrompt(body.tools) + "\n\n" + prompt;
  }
  const id = chatId();
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    let attempt = 0, cur = prompt;
    while (true) {
      const r = await askRawResponse(cur, { think: true });
      const text = await r.text();
      let merged = "";
      for (const m of text.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)) merged += JSON.parse('"' + m[1] + '"');
      const err = !merged && text.match(/"msg":"([^"]*)"/);
      if (err) throw new Error(err[1]);
      const thinkMatch = merged.match(/<think>([\s\S]*?)(<\/think>|$)/);
      let reasoning = "", content = merged;
      if (thinkMatch) {
        reasoning = thinkMatch[1].trim();
        content = merged.slice(thinkMatch.index + thinkMatch[0].length).trim();
      }
      // 工具调用解析：<tool_call> 协议 + DSML 原生调用桥接
      let toolCalls = null, finish = "stop";
      if (hasTools) {
        const calls = extractToolCalls(content);
        let oai = calls.length ? fixupCalls(calls, body.tools).map((c, i) => ({ id: `call_${Date.now().toString(36)}_${i}`, type: "function", function: c })) : null;
        if (!oai) {
          const inv = extractDSMLInvokes(merged);
          const comp = inv.length ? extractCompletionResult(inv) : null;
          if (comp) {
            // attempt_completion 类交付：result 就是最终答案，直接作为正文返回
            content = comp;
          } else {
            const mapped = inv.length ? mapDSMLToClient(inv, body.tools) : [];
            if (mapped.length) oai = mapped.map((c, i) => ({ id: `call_dsml_${Date.now().toString(36)}_${i}`, type: "function", function: c }));
          }
        }
        if (!oai) {
          // 叙述式调用：模型模仿历史格式输出「[助手发起了工具调用] Name({...})」
          const ncalls = [];
          const linesOut = [];
          for (const line of merged.split("\n")) {
            const mN = line.match(/\[助手发起了工具调用\]\s*([A-Za-z_]\w*)\(([\s\S]*)\)\s*$/);
            if (mN) { ncalls.push({ name: mN[1], arguments: mN[2].trim() }); continue; }
            if (/\[工具 [^\]]*的执行结果\]/.test(line) || /^\s*\[系统\]/.test(line)) continue;
            linesOut.push(line);
          }
          if (ncalls.length) {
            oai = ncalls.map((c, i) => ({ id: `call_nar_${Date.now().toString(36)}_${i}`, type: "function", function: c }));
            merged = linesOut.join("\n");
          }
        }
        if (oai) {
          content = sanitizeText(content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")).trim();
          toolCalls = oai;
          finish = "tool_calls";
        }
      }
      const finalContent = sanitizeText(content).replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "").trim();
      // Agent 停止 / 拒绝调用工具 / 有工具却没总结 → 自动升级重试
      // missing-summary 仅在历史里确实有工具结果时判定（否则简短的正常回答会被误升级重试）
      const historyHasToolResults = (body.messages || []).some((m) => m && m.role === "tool");
      const refuseTool = hasTools && !toolCalls && /不允许调用工具|无法调用工具|无法调用|请你手动|手动将以下|手动保存/.test(finalContent);
      const announced = hasTools && !toolCalls && (isAnnouncedOnly(finalContent) || (historyHasToolResults && isAnnouncedLoose(finalContent)));
      const emptyGen = hasTools && !toolCalls && finalContent.trim() === "";
      const missingSummary = hasTools && !toolCalls && historyHasToolResults && isAgentStop(finalContent);
      let kind = null;
      if (refuseTool) kind = "tool-refuse";
      else if (emptyGen) kind = "empty-gen";
      else if (announced) kind = "announced";
      else if (missingSummary) kind = "missing-summary";
      else if (!hasTools && isPlanStopStyle(finalContent)) kind = "plan-stop";
      const ladder = { "tool-refuse": TOOL_ESCALATION, "empty-gen": TOOL_ESCALATION, "announced": CONTINUE_ESCALATION, "missing-summary": CONTINUE_ESCALATION, "plan-stop": ANTI_AGENT }[kind];
      if (kind && attempt < ladder.length) {
        console.error(`[anti-agent] 检测到异常（${kind}），升级重试 #${attempt + 1}`);
        attempt++;
        cur = kind === "empty-gen" ? toolEscalate(prompt, attempt, "\n（不要思考、不要规划，直接输出最终答案正文。）")
            : kind === "tool-refuse" ? toolEscalate(prompt, attempt)
            : kind === "announced" || kind === "missing-summary" ? continueEscalate(prompt, attempt, hasTools ? TOOL_FMT_TAIL : "")
            : escalatePrompt(prompt, attempt);
        continue;
      }
      sendJSON(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: finalContent,
            ...(reasoning ? { reasoning_content: sanitizeText(reasoning) } : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finish,
        }],
        usage: {
          prompt_tokens: estimateTokens(cur),
          completion_tokens: estimateTokens(finalContent),
          total_tokens: estimateTokens(cur) + estimateTokens(finalContent),
        },
      });
      return;
    }
  }

  // ===== 流式 =====
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (delta, finish = null) => {
    res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  };
  emit({ role: "assistant", content: "" });

  let attempt = 0, cur = prompt;
  while (true) {
    let raw;
    try {
      raw = await askRawResponse(cur, { think: true });
    } catch (e) {
      console.error("[stream] 上游请求失败:", e.message);
      emitPlain("⚠️ 上游请求失败：" + e.message);
      emit({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // 每次尝试的独立状态（必须在 try 外声明，catch 与收尾段才能访问）
    let insideThink = false, fullContent = "", fullReasoning = "";
    let held = "", gateOpen = false, pending = "";
    const dsmlCalls = [];
    // 终端发射器：不回流到任何过滤器（避免递归）
  let prevLine = null, dupCount = 0;
  const collapseDupLines = (s) => {
    const out = [];
    for (const ln of s.split("\n")) {
      if (ln === prevLine && ln.trim() !== "") {
        dupCount++;
        if (dupCount > 2) continue; // 同一连续行最多保留 3 次，防复读刷屏
      } else { prevLine = ln; dupCount = 0; }
      out.push(ln);
    }
    return out.join("\n");
  };
  const emitPlain = (t) => {
    gateOpen = true;
    if (held) { emit({ content: held }); held = ""; }
    if (!t) return;
    const c = collapseDupLines(t);
    if (c) emit({ content: c });
  };
    const narrated = hasTools ? makeNarratedCallFilter((t) => {
      // 短答案缓冲：攒到 400 字才放行（「宣而不做」可静默重试不重复；长回答保持近实时）
      pending += t;
      if (pending.length >= 400) { emitPlain(pending); pending = ""; }
    }, (name, argsJson) => {
      dsmlCalls.push({ name, arguments: argsJson });
      gateOpen = true;
      if (pending) { emitPlain(pending); pending = ""; }
      if (held) { emit({ content: held }); held = ""; }
    }) : null;
    const toolFilter = hasTools ? makeToolCallFilter((t) => {
      if (narrated) narrated.feed(t); else emitPlain(t);
    }) : null;
    try {

  // 先过 DSML 过滤器，再按 <think> 标签切分 reasoning/content
  const emitPiece = (text) => {
    if (!text) return;
    const outContent = (t) => {
      fullContent += t;
      if (toolFilter) { toolFilter.feed(t); return; }
      if (!gateOpen) {
        // 仅带工具的请求需要缓冲（为静默重试保留机会）；普通对话实时流出
        if (!hasTools) { gateOpen = true; if (t) emit({ content: t }); return; }
        held += t;
        if (held.trim().length >= 150) {
          const h = held; held = ""; gateOpen = true;
          if (narrated) { narrated.feed(h); } else emitPlain(h);
        }
        return;
      }
      if (narrated) narrated.feed(t); else emitPlain(t);
    };
    let rest = text;
    while (rest.length) {
      if (!insideThink) {
        const open = rest.indexOf("<think>");
        if (open === -1) {
          outContent(rest);
          rest = "";
        } else {
          if (open > 0) { outContent(rest.slice(0, open)); }
          insideThink = true;
          rest = rest.slice(open + 7);
        }
      } else {
        const close = rest.indexOf("</think>");
        if (close === -1) {
          fullReasoning += rest;
          emit({ reasoning_content: rest });
          rest = "";
        } else {
          if (close > 0) { fullReasoning += rest.slice(0, close); emit({ reasoning_content: rest.slice(0, close) }); }
          insideThink = false;
          rest = rest.slice(close + 8);
        }
      }
    }
  };
  const dsmlFilter = makeDSMLFilter(emitPiece, hasTools ? (block) => {
    // DSML 原生调用 → 桥接为客户端真实工具
    const inv = extractDSMLInvokes(block);
    if (!inv.length) return salvageDSML(block);
    const comp = extractCompletionResult(inv);
    if (comp) return sanitizeText(comp); // attempt_completion 交付：result 作为正文流回
    const mapped = mapDSMLToClient(inv, body.tools);
    if (!mapped.length) return salvageDSML(block);
    dsmlCalls.push(...mapped);
    gateOpen = true;
    if (pending) { emitPlain(pending); pending = ""; }
    if (held) { if (narrated) narrated.feed(held); else emit({ content: held }); held = ""; }
    return "";
  } : null);
  let upstreamBytes = 0;
  await streamDeltas(raw, (text) => { upstreamBytes += text.length; dsmlFilter.feed(text); });
  dsmlFilter.flush(); // 冲刷扣留的尾巴（未闭合垃圾块则直接丢弃）
  if (toolFilter) toolFilter.flush();
  console.error(`[upstream] 上游输出 ${upstreamBytes} 字 | prompt ${cur.length} 字 | content ${fullContent.length} reasoning ${fullReasoning.length}`);

  // 工具调用收尾（<tool_call> 协议 + DSML 桥接合并）
  const fixedTool = toolFilter ? fixupCalls(toolFilter.calls, body.tools) : [];
  const allCalls = [
    ...fixedTool.map((c, i) => ({ index: i, id: `call_tc_${i}`, type: "function", function: c })),
    ...dsmlCalls.map((c, i) => ({ index: fixedTool.length + i, id: `call_dsml_${Date.now().toString(36)}_${i}`, type: "function", function: c })),
  ];
  if (hasTools && allCalls.length) {
    if (pending) { emitPlain(pending); pending = ""; } // 调用前的说明文字先放行
    emit({ tool_calls: allCalls });
    emit({}, "tool_calls");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // Agent 停止 / 拒绝调用工具 / 有工具却没总结 → 升级重试（正文尚未发出，可安全重来）
  // missing-summary 仅在历史里确实有工具结果时判定（与此前"有调用即提前 return"叠加，此处必为无新调用）
  const historyHasToolResults = (body.messages || []).some((m) => m && m.role === "tool");
  const refuseTool = hasTools && !allCalls.length &&
    /不允许调用工具|无法调用工具|无法调用|请你手动|手动将以下|手动保存/.test(fullContent);
  const announced = hasTools && !allCalls.length && (isAnnouncedOnly(fullContent) || (historyHasToolResults && isAnnouncedLoose(fullContent)));
  const emptyGen = hasTools && !allCalls.length && fullContent.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "").trim() === "";
  const missingSummary = hasTools && !allCalls.length && historyHasToolResults && isAgentStop(fullContent);
  let kind = null;
  if (refuseTool) kind = "tool-refuse";
  else if (emptyGen) kind = "empty-gen";
  else if (announced) kind = "announced";
  else if (missingSummary) kind = "missing-summary";
  else if (!hasTools && isPlanStopStyle(fullContent)) kind = "plan-stop";
  const ladder = { "tool-refuse": TOOL_ESCALATION, "empty-gen": TOOL_ESCALATION, "announced": CONTINUE_ESCALATION, "missing-summary": CONTINUE_ESCALATION, "plan-stop": ANTI_AGENT }[kind];
  if (kind && attempt < ladder.length) {
    console.error(`[anti-agent][stream] 检测到异常（${kind}），升级重试 #${attempt + 1}`);
    attempt++;
    cur = kind === "empty-gen" ? toolEscalate(prompt, attempt, "\n（不要思考、不要规划，直接输出最终答案正文。）")
        : kind === "tool-refuse" ? toolEscalate(prompt, attempt)
        : kind === "announced" || kind === "missing-summary" ? continueEscalate(prompt, attempt, hasTools ? TOOL_FMT_TAIL : "")
        : escalatePrompt(prompt, attempt);
    insideThink = false; fullContent = ""; fullReasoning = ""; held = ""; gateOpen = false; pending = "";
    continue;
  }

  } catch (e) {
    console.error("[stream] 输出中断:", e.message);
    if (!gateOpen && attempt < ANTI_AGENT.length) {
      // 尚未向客户端发出任何正文 → 静默升级重试
      attempt++;
      cur = escalatePrompt(prompt, attempt);
      insideThink = false; fullContent = ""; fullReasoning = ""; held = ""; gateOpen = false; pending = "";
      continue;
    }
    emitPlain("⚠️ 输出中断：" + e.message);
    emit({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // 收尾冲刷：narrated 行缓冲里无换行结尾的最后一段必须吐出，否则短答案（如"5"、"已完成。"）整段被吞
  if (narrated) {
    narrated.flush();
    if (pending) { emitPlain(pending); pending = ""; }
  } else if (held && !gateOpen && held.trim()) {
    emit({ content: held });
  }
  emit({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
  return;
  } // while
}

/** phoenix agent-chat 通道处理（csdn-agent-flash/pro，无工具场景专用） */
function openAIToPhoenixQuery(messages) {
  let sysPrefix = "";
  const query = [];
  for (const m of messages || []) {
    const c = normContent(m.content);
    if (!c) continue;
    if (m.role === "system") { sysPrefix += (sysPrefix ? "\n" : "") + c; continue; }
    if (m.role === "assistant") query.push({ role: "assistant", content: c });
    else if (m.role === "tool") query.push({ role: "user", content: "[工具结果] " + c });
    else {
      query.push({ role: "user", content: sysPrefix ? sysPrefix + "\n\n" + c : c });
      sysPrefix = "";
    }
  }
  if (sysPrefix) query.push({ role: "user", content: sysPrefix });
  return query;
}

/** 只聊天快模型：Dify 检索通道路由（webSearch=0，无工具）。
 *  多轮记忆：复用 Dify sessionId（后端"获取上一轮对话详情"节点记上下文），query 只发最新一句——
 *  之前把历史拼进 query 会导致意图节点挑错问题（"新的问题和回答不同步"的根因）。 */
const difySidMap = new Map(); // convKey → sid
function difySidFor(key) {
  if (difySidMap.has(key)) { const s = difySidMap.get(key); difySidMap.delete(key); difySidMap.set(key, s); return s; }
  return "";
}
function difySidSave(key, sid) {
  if (difySidMap.size > 100) difySidMap.delete(difySidMap.keys().next().value);
  difySidMap.set(key, sid);
}

async function handleDifyChat(req, res, body, model, stream) {
  const modelId = DIFY_FAST_MODELS[model];
  const msgs = (body.messages || []).filter((m) => m.role !== "system"); // Claude Code 系统提示过大，该通道无工具概念，直接弃
  const last = msgs[msgs.length - 1] || {};
  const message = typeof last.content === "string" ? last.content : normContent(last.content);
  // 会话键：首条用户消息 hash（Claude Code 每轮重发全量历史，首条不变即同一对话）
  const firstUser = msgs.find((m) => m.role === "user");
  const convKey = nodeCrypto.createHash("md5").update(String(firstUser ? (typeof firstUser.content === "string" ? firstUser.content : normContent(firstUser.content)) : "")).digest("hex").slice(0, 12);
  const sid = difySidFor(convKey);
  const id = chatId();
  const created = Math.floor(Date.now() / 1000);
  let answer = "", errored = null;

  const onEvent = (ev) => {
    if (ev.t === "sid") difySidSave(convKey, ev.sid);
    else if (ev.t === "answer") { answer += ev.text || ""; if (stream) emit({ content: ev.text || "" }); }
    else if (ev.t === "error") errored = ev.msg;
  };

  if (!stream) {
    await webuiChannels.searchStream({ query: message, webSearch: registry.getWebSearchGlobals().api ? "1" : "0", modelId, sid, docIds: body.docIds || "" }, onEvent);
    if (errored) return sendJSON(res, 502, { error: { message: errored } });
    return sendJSON(res, 200, {
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: answer.length, total_tokens: answer.length },
    });
  }
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (delta, finish) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`);
  emit({ role: "assistant" });
  try {
    await webuiChannels.searchStream({ query: message, webSearch: registry.getWebSearchGlobals().api ? "1" : "0", modelId, sid, docIds: body.docIds || "" }, onEvent);
  } catch (e) {
    errored = errored || String((e && e.message) || e);
    console.error("[dify-fast] 流式异常:", errored);
  }
  if (errored && !answer) emit({ content: "⚠️ 上游异常：" + errored }, "stop");
  else emit({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handlePhoenixChat(req, res, body, model, csdnModel, stream) {
  const query = openAIToPhoenixQuery(body.messages);
  // 附件：最后一条 user 消息里的 [[文件:路径]] → 上传 CSDN 文档分析接口，kwargs.file_url 交给后端 agent
  let fileUrl = "";
  for (let i = query.length - 1; i >= 0; i--) {
    if (query[i].role === "user") {
      const marks = [...query[i].content.matchAll(/\[\[(?:文件|file):([^\]]+)\]\]/g)];
      if (marks.length) {
        try {
          const up = await uploadDoc(marks[0][1].trim());
          fileUrl = up.url;
          query[i].content = query[i].content.replace(/\[\[(?:文件|file):[^\]]+\]\]/g, `[已上传文档 ${up.fileName}，请基于该文档内容回答]`);
          console.log(`[phoenix] 附件已上传: ${marks[0][1]} → ${up.fileName}`);
        } catch (e) {
          query[i].content = query[i].content.replace(/\[\[(?:文件|file):[^\]]+\]\]/g, "[附件上传失败: " + e.message + "]");
          console.error("[phoenix] 附件上传失败:", e.message);
        }
      }
      break;
    }
  }
  const id = chatId();
  const created = Math.floor(Date.now() / 1000);
  console.log(`[phoenix] ${new Date().toLocaleTimeString()} model=${csdnModel} turns=${query.length} stream=${stream}`);
  try {
    if (!stream) {
      const r = await agentChatComplete(query, { model: csdnModel, fileUrl });
      const content = sanitizeText(r.answer);
      return sendJSON(res, 200, {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content, ...(r.reasoning ? { reasoning_content: sanitizeText(r.reasoning) } : {}) }, finish_reason: "stop" }],
        usage: { prompt_tokens: estimateTokens(JSON.stringify(query)), completion_tokens: estimateTokens(content), total_tokens: 0 },
      });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const emit = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    emit({ role: "assistant", content: "" });
    await streamAgentChat(query, { model: csdnModel, fileUrl }, (ev) => {
      if (ev.kind === "answer-delta") emit({ content: ev.delta });
      else if (ev.kind === "reasoning") emit({ reasoning_content: ev.delta });
      else if (ev.kind === "done") {
        // 工具产物（attempt_completion 等）未随流式正文发出时，结尾一次性补发
        const a = ev.answer || "", s = ev.streamedAnswer || "";
        if (a && a !== s) {
          if (s && a.startsWith(s)) { if (a.length > s.length) emit({ content: a.slice(s.length) }); }
          else emit({ content: (s ? "\n\n" : "") + a });
        }
        console.error(`[upstream][phoenix] 流式完成 content=${a.length}字（流内 ${s.length}字）`);
      }
    });
    emit({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    console.error("[phoenix] 通道异常:", e.message);
    if (!res.headersSent) return sendJSON(res, 502, { error: { message: e.message, type: "upstream_error" } });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: "⚠️ 上游异常：" + e.message }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

/** ===== Anthropic /v1/messages 兼容层（Claude Code 直连，摆脱 cc-switch 中转） ===== */

function safeParseJSON(s) { try { return JSON.parse(s); } catch { return {}; } }

function translateAnthropicToOpenAI(body) {
  const messages = [];
  const sys = typeof body.system === "string" ? body.system : normContent(body.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of body.messages || []) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = [], toolCalls = [];
      for (const b of m.content || []) {
        if (b.type === "text" && b.text) text.push(b.text);
        else if (b.type === "tool_use") toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        // thinking 块忽略
      }
      const msg = { role: "assistant", content: text.join("\n") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else if (m.role === "user") {
      const parts = [];
      for (const b of m.content || []) {
        if (b.type === "text" && b.text) parts.push(b.text);
        else if (b.type === "tool_result") {
          // tool_result 内容数组：文本照常走 tool 消息；其中的图片（截图工具回传）转占位说明
          let c;
          if (Array.isArray(b.content)) {
            c = b.content.map((tb) => {
              if (tb && tb.type === "text" && tb.text) return tb.text;
              if (tb && tb.type === "image") return "[工具回传了一张截图，纯文本通道无法看图，请基于工具的文字输出继续]";
              return "";
            }).filter(Boolean).join("\n");
          } else {
            c = typeof b.content === "string" ? b.content : normContent(b.content);
          }
          messages.push({ role: "tool", tool_call_id: b.tool_use_id || "", name: b.name || "", content: c });
        } else if (b.type === "image") parts.push("[图片]");
      }
      if (parts.length) messages.push({ role: "user", content: parts.join("\n") });
    }
  }
  const tools = (body.tools || []).map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
  return { model: body.model, messages, tools: tools.length ? tools : undefined, stream: !!body.stream };
}

function anthropicSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleAnthropicMessages(req, res, body) {
  // 附件桥（与 handleChat 共用 bridgeAttachmentPart，双协议一致）：
  // - 小文本附件（≤30KB）→ 内联（保持原模型）
  // - 大文本 / 二进制文档（pdf/docx 等）→ [[文件:]] 标记走 phoenix 已验证文档链路
  // - 图片 → aisearch docUpload → docId → Dify 检索流（V4 Flash 有视觉，实测能读截图）
  let hasAttachment = false, attDocId = "", attPhoenix = false;
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (let bi = 0; bi < m.content.length; bi++) {
      const b = m.content[bi];
      if (!b || typeof b !== "object" || b.type === "text" || b.type === "tool_result") continue;
      const r = await bridgeAttachmentPart(b, "msg").catch((e) => ({ marker: "[附件处理失败: " + String(e.message || e).slice(0, 80) + "]" }));
      if (r) {
        hasAttachment = true;
        m.content[bi] = { type: "text", text: r.marker };
        if (r.docId) attDocId = r.docId; else if (r.phoenix) attPhoenix = true;
        console.log("[messages] 附件桥:", r.docId ? "Dify docId " + r.docId : "phoenix 文档链路", "|", r.marker.slice(0, 40));
      }
    }
  }
  const oa = translateAnthropicToOpenAI(body);
  if (attDocId) {
    // 二进制文档/图片 → Dify 检索流（有解析器/视觉）；请求的模型若不是 Dify 系则用实测全能的 V4 Flash
    oa.model = DIFY_FAST_MODELS[oa.model] ? oa.model : "csdn-v4-flash";
    oa.tools = undefined; // Dify 通道无客户端工具
    oa.docIds = String(attDocId);
    for (const m of oa.messages) if (typeof m.content === "string") m.content = m.content.replace(/\[\[文件:[^\]]*\]\]/g, "[已上传附件，随消息分析]");
    console.log("[messages] 附件请求路由 Dify:", oa.model);
  } else if (attPhoenix) {
    oa.model = "csdn-agent-flash"; // [[文件:]] 文档链路只有 phoenix 通道能读
    oa.tools = undefined;          // 该通道无客户端工具，附件问答不需要
    console.log("[messages] 文档附件请求路由 csdn-agent-flash");
  } else if (hasAttachment) {
    console.log("[messages] 小文本附件已内联（保持原模型）");
  }
  if (!oa.messages.length) return sendJSON(res, 400, { type: "error", error: { type: "invalid_request_error", message: "messages is required" } });
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const upstream = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(oa),
  });
  if (!upstream.ok) {
    const t = await upstream.text();
    return sendJSON(res, upstream.status, { type: "error", error: { type: "upstream_error", message: t.slice(0, 300) } });
  }
  const msgId = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const modelName = body.model || "deepseek-chat";

  if (!body.stream) {
    const j = await upstream.json();
    const ch = j.choices && j.choices[0];
    if (!ch) return sendJSON(res, 502, { type: "error", error: { type: "upstream_error", message: "empty choices" } });
    const content = [];
    if (ch.message && ch.message.content) content.push({ type: "text", text: ch.message.content });
    for (const tc of (ch.message && ch.message.tool_calls) || []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeParseJSON(tc.function.arguments) });
    }
    if (!content.length) content.push({ type: "text", text: "" });
    return sendJSON(res, 200, {
      id: msgId, type: "message", role: "assistant", model: modelName, content,
      stop_reason: ch.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: (j.usage && j.usage.prompt_tokens) || 0, output_tokens: (j.usage && j.usage.completion_tokens) || 0 },
    });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  anthropicSSE(res, "message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model: modelName, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  let textOpen = false, nextIndex = 0;
  const openText = () => { if (!textOpen) { anthropicSSE(res, "content_block_start", { type: "content_block_start", index: nextIndex, content_block: { type: "text", text: "" } }); textOpen = true; nextIndex++; } };
  const closeText = () => { if (textOpen) { anthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: nextIndex - 1 }); textOpen = false; } };
  let stopReason = "end_turn";
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", outTokens = 0;
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
      let j; try { j = JSON.parse(payload); } catch { continue; }
      const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
      const fr = j.choices && j.choices[0] && j.choices[0].finish_reason;
      if (d.reasoning_content) { /* Anthropic 思考块需签名字段，暂不透传 */ }
      if (d.content) { openText(); anthropicSSE(res, "content_block_delta", { type: "content_block_delta", index: nextIndex - 1, delta: { type: "text_delta", text: d.content } }); outTokens += d.content.length; }
      if (Array.isArray(d.tool_calls)) {
        closeText();
        for (const tc of d.tool_calls) {
          anthropicSSE(res, "content_block_start", { type: "content_block_start", index: nextIndex, content_block: { type: "tool_use", id: tc.id, name: tc.function && tc.function.name, input: {} } });
          anthropicSSE(res, "content_block_delta", { type: "content_block_delta", index: nextIndex, delta: { type: "input_json_delta", partial_json: (tc.function && tc.function.arguments) || "{}" } });
          anthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: nextIndex });
          nextIndex++;
        }
        stopReason = "tool_use";
      }
      if (fr === "tool_calls") stopReason = "tool_use";
    }
  }
  closeText();
  anthropicSSE(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: Math.ceil(outTokens / 2) } });
  anthropicSSE(res, "message_stop", { type: "message_stop" });
  res.end();
}

/** ===== OpenAI Responses API 兼容层（/v1/responses，Codex CLI 0.150+ 只讲这一种） ===== */

/** Responses 请求 → chat completions 请求 */
function responsesToChat(body) {
  const messages = [];
  let cwdHint = "";
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const pushToolCall = (item) => {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: item.call_id || item.id || "call_x", type: "function", function: { name: item.name || "unknown", arguments: item.arguments || "{}" } }],
    });
  };
  const inputItems = Array.isArray(body.input) ? body.input : (body.input ? [{ type: "message", role: "user", content: [{ type: "input_text", text: String(body.input) }] }] : []);
  for (const it of inputItems) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "message" || (!it.type && it.role)) {
      const c = it.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.map((p) => (typeof p === "string" ? p : (p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
      else if (c && typeof c.text === "string") text = c.text;
      if (text) {
        if (!cwdHint) { const m = text.match(/<cwd>([\s\S]*?)<\/cwd>/); if (m) cwdHint = m[1].trim(); }
        messages.push({ role: it.role === "developer" ? "system" : it.role || "user", content: text });
      }
    } else if (it.type === "function_call") {
      pushToolCall(it);
    } else if (it.type === "function_call_output") {
      const out = typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "");
      messages.push({ role: "tool", tool_call_id: it.call_id || "", content: out });
    }
    // 其他类型（reasoning 等）跳过
  }
  if (!messages.length) messages.push({ role: "user", content: "(empty)" });
  const tools = (body.tools || []).filter((t) => !t.type || t.type === "function").map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } },
  }));
  return { model: body.model, messages, tools: tools.length ? tools : undefined, stream: !!body.stream, cwdHint };
}

function chatToOutputItems(j) {
  const ch = j.choices && j.choices[0];
  const msg = (ch && ch.message) || {};
  const items = [];
  if (msg.content) items.push({ type: "message", id: "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.content, annotations: [] }] });
  for (const tc of msg.tool_calls || []) {
    items.push({ type: "function_call", id: "fc_" + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
  }
  return items;
}

async function handleResponses(req, res, body) {
  const oa = responsesToChat(body);
  // 注入 write_file 工具：写文件绕开 shell 的引号/编码/截断三坑，网关本地落盘（对 codex 透明）
  oa.tools = oa.tools || [];
  if (!oa.tools.some((t) => t.function && t.function.name === "write_file")) {
    oa.tools.push({
      type: "function",
      function: {
        name: "write_file",
        description: "创建或覆盖本地文件并自动创建目录（写代码/配置文件优先用本工具，UTF-8 无乱码，比 shell 重定向可靠）",
        parameters: { type: "object", properties: { path: { type: "string", description: "相对当前工作目录的路径" }, content: { type: "string", description: "完整文件内容" } }, required: ["path", "content"] },
      },
    });
  }
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const loopback = `http://127.0.0.1:${PORT}/v1/chat/completions`;

  // 内部循环：write_file 由网关本地执行并回灌结果，最多 8 轮；出现 shell 调用或纯文本则终止，交给 codex
  let finalJ = null;
  try {
    for (let round = 0; ; round++) {
      // 内部调用失败（上游瞬时故障 502/断连）自动重试一次
      let j = null, lastErr = null, lastStatus = 502;
      for (let attempt = 0; attempt < 2 && !j; attempt++) {
        const r = await fetch(loopback, { method: "POST", headers, body: JSON.stringify({ model: oa.model, messages: oa.messages, tools: oa.tools, stream: false }) });
        if (r.ok) { j = await r.json(); break; }
        lastStatus = r.status; lastErr = (await r.text()).slice(0, 300);
        if (attempt === 0) { console.error("[responses] 内部调用失败(" + lastStatus + ")，3 秒后重试一次"); await new Promise((res2) => setTimeout(res2, 3000)); }
      }
      if (!j) return sendJSON(res, lastStatus, { type: "error", code: "upstream_error", message: lastErr });
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      const calls = msg.tool_calls || [];
      const wf = calls.filter((c) => c.function && c.function.name === "write_file");
      const others = calls.filter((c) => !(c.function && c.function.name === "write_file"));
      if (wf.length) {
        // write_file 永远由网关本地落盘，绝不透传给 codex（codex 无此工具，会报 unsupported call）
        oa.messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
        for (const tc of wf) {
          let out;
          try {
            const a = JSON.parse(tc.function.arguments || "{}");
            if (!a.path) throw new Error("缺少 path 参数");
            const p = path.isAbsolute(a.path) ? a.path : path.join(oa.cwdHint || process.cwd(), a.path);
            if (oa.cwdHint && !path.resolve(p).startsWith(path.resolve(oa.cwdHint))) throw new Error("路径越出工作区，已拒绝: " + a.path);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, String(a.content ?? ""), "utf8");
            const bytes = Buffer.byteLength(String(a.content ?? ""), "utf8");
            console.log(`[write_file] ${p} (${bytes}B)`);
            out = `OK: 已写入 ${a.path}（${bytes} 字节）`;
          } catch (e) {
            out = "ERROR: " + (e.message || e);
          }
          oa.messages.push({ role: "tool", tool_call_id: tc.id, content: out });
        }
        if (others.length || round >= 8) {
          // 混合轮或额度用尽：write_file 已落盘，其余真实调用（shell 等）原样交 codex；无其余调用则以文本收尾
          finalJ = { ...j, choices: [{ ...j.choices[0], message: { role: "assistant", content: msg.content || "", tool_calls: others } }] };
          break;
        }
        if (round === 7) oa.messages.push({ role: "user", content: "【系统】write_file 本请求额度已用完，请直接给出面向用户的最终答复。" });
        continue; // 纯 write_file 轮：回灌结果后继续内部循环
      }
      finalJ = j;
      break;
    }
  } catch (e) {
    return sendJSON(res, 502, { type: "error", code: "upstream_error", message: String((e && e.message) || e).slice(0, 300) });
  }

  const j = finalJ;
  const ch = j.choices && j.choices[0];
  if (!ch) return sendJSON(res, 502, { type: "error", code: "upstream_error", message: "empty choices" });
  const respId = "resp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const output = chatToOutputItems(j);
  const usage = {
    input_tokens: (j.usage && j.usage.prompt_tokens) || 0,
    output_tokens: (j.usage && j.usage.completion_tokens) || 0,
    total_tokens: (j.usage && j.usage.total_tokens) || 0,
  };
  const textItem = output.find((o) => o.type === "message");

  if (!body.stream) {
    return sendJSON(res, 200, {
      id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
      model: (body.model || "deepseek-chat"), output, output_text: textItem ? textItem.content[0].text : "",
      usage, parallel_tool_calls: true,
    });
  }

  // 合成流式事件（内部循环期间不产生流，最终结果一次性推给 codex）
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("response.created", { type: "response.created", response: { id: respId, object: "response", status: "in_progress", model: (body.model || "deepseek-chat"), output: [] } });
  let idx = 0;
  for (const item of output) {
    if (item.type === "message") {
      emit("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { type: "message", id: item.id, role: "assistant", status: "in_progress", content: [] } });
      const text = item.content[0].text;
      for (let off = 0; off < text.length; off += 240) {
        emit("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, delta: text.slice(off, off + 240) });
      }
      emit("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
    } else {
      emit("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: "", status: "in_progress" } });
      emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments });
      emit("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
    }
    idx++;
  }
  emit("response.completed", {
    type: "response.completed",
    response: { id: respId, object: "response", status: "completed", model: (body.model || "deepseek-chat"), output, usage },
  });
  res.end();
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    res.on("error", () => {}); // 客户端中途断开时 res 流可能抛错，吞掉防止炸进程
    if (req.url.startsWith("/health")) return sendJSON(res, 200, { ok: true });

    if (req.url.startsWith("/v1/models") || req.url === "/models") {
      return sendJSON(res, 200, {
        object: "list",
        data: Object.keys(registry.ALL_MODELS).filter((id) => registry.isModelEnabled(id)).map((id) => ({ id, object: "model", owned_by: "csdn-proxy" })),
      });
    }

    const isAskSimple = req.url.startsWith("/ask");
    const isMessages = req.url.startsWith("/v1/messages"); // Anthropic 协议（Claude Code 直连）
    const isResponses = req.url.startsWith("/v1/responses"); // Responses 协议（Codex CLI 0.150+）
    const isChat = req.url.startsWith("/v1/chat/completions") || req.url.startsWith("/chat/completions");
    if (!isChat && !isAskSimple && !isMessages && !isResponses) return sendJSON(res, 404, { error: "not found" });
    if (!checkAuth(req)) return sendJSON(res, 401, { error: { message: "invalid api key", type: "auth_error" } });

    let data = "";
    req.on("data", (c) => (data += c));
    await new Promise((r) => req.on("end", r));
    const body = data ? JSON.parse(data) : {};

    if (isResponses) {
      console.log(`[responses] ${new Date().toLocaleTimeString()} stream=${!!body.stream} model=${body.model || ""}`);
      await handleResponses(req, res, body);
      return;
    }

    if (isMessages) {
      if (!body.messages?.length) return sendJSON(res, 400, { type: "error", error: { type: "invalid_request_error", message: "messages is required" } });
      console.log(`[messages] ${new Date().toLocaleTimeString()} msgs=${body.messages.length} stream=${!!body.stream} model=${body.model || ""}`);
      await handleAnthropicMessages(req, res, body);
      return;
    }

    if (isChat) {
      if (!body.messages?.length) return sendJSON(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } });
      const lastMsg = body.messages[body.messages.length - 1];
      const headTxt = (typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content) || "").slice(0, 50);
      console.log(`[chat] ${new Date().toLocaleTimeString()} msgs=${body.messages.length} stream=${!!body.stream} last=${JSON.stringify(headTxt)}`);
      await handleChat(req, res, body);
      return;
    }

    // 旧简易格式 /ask
    const prompt = body.prompt || "";
    if (!prompt) return sendJSON(res, 400, { error: '缺少 prompt' });
    const result = await ask(prompt, { think: body.think ?? true });
    sendJSON(res, 200, { answer: result.answer, reasoning: result.reasoning || undefined });
  } catch (e) {
    console.error("[err]", e.message);
    if (!res.headersSent) sendJSON(res, 502, { error: { message: e.message, type: "upstream_error" } });
    else res.end();
  }
});

// 崩溃防护：任何未捕获异常只记日志不退进程（本服务每个请求相互独立，可用性优先）
process.on("uncaughtException", (e) => console.error(`[crash-guard] uncaughtException: ${(e && e.stack) || e}`));
process.on("unhandledRejection", (e) => console.error(`[crash-guard] unhandledRejection: ${(e && (e.stack || e.message)) || e}`));

server.listen(PORT, () => {
  console.log(`CSDN AI (DeepSeek/OpenAI 兼容) API 已启动:`);
  console.log(`  baseURL: http://localhost:${PORT}/v1`);
  console.log(`  apiKey : ${API_KEY ? "(已启用校验)" : "任意值（未启用校验）"}`);
  console.log(`测试: curl http://localhost:${PORT}/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'`);
});