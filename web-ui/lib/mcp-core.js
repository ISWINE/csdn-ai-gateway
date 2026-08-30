/**
 * MCP 核心逻辑（传输无关）：TOOLS 定义 + JSON-RPC 分发。
 * 三种传输共用：stdio（mcp-server.js）/ streamable HTTP（POST /mcp）/ legacy SSE（/mcp/sse）。
 */
const path = require("path");
const fs = require("fs");
const channels = require("./channels");
const registry = require("./models-registry");

const SERVER_INFO = { name: "csdn-aggregate", version: "1.1.0" };

const TOOLS = [
  {
    name: "parse_file",
    description: "聚合解析：上传本地文件（文本/图片/PDF/Word 等）到 CSDN 并用 DeepSeek-V4 Flash 解析，回答针对文件内容的问题。适合大文件、二进制文档、图片。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" },
        question: { type: "string", description: "想问文件内容的问题" },
      },
      required: ["path", "question"],
    },
  },
  {
    name: "analyze_image",
    description: "图片分析：上传图片并用 V4 Flash 视觉模型回答问题（截图内容识别、图表读数等）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "图片的绝对路径" },
        question: { type: "string", description: "关于图片的问题" },
      },
      required: ["path", "question"],
    },
  },
  {
    name: "csdn_search",
    description: "CSDN AI 搜索（全模态解析套件）：站内博客检索 + 可选联网，返回带引用来源的回答。查技术资料/时效性信息时用。联网默认值跟随 web 设置面板的「API 全局联网」开关。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索问题" },
        web_search: { type: "boolean", description: "是否联网检索（不传则跟随 API 全局联网开关）" },
      },
      required: ["query"],
    },
  },
  {
    name: "fast_chat",
    description: "快聊问答（无工具、联网跟随 API 全局开关）。可选模型：csdn-v3-0324/csdn-qwen3-32b/csdn-qwen3-32b-think/csdn-qwen-plus/csdn-v4-flash，默认 csdn-v3-0324。受 web 设置面板开关约束。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        model: { type: "string", enum: Object.keys(registry.ALL_MODELS), default: "csdn-v3-0324" },
      },
      required: ["query"],
    },
  },
];

const DIFY_SET = new Map([["csdn-v3-0324", "6"], ["csdn-qwen3-32b", "14"], ["csdn-qwen3-32b-think", "15"], ["csdn-qwen-plus", "2"], ["csdn-v4-flash", "3"]]);

async function difyAsk({ query, docIds = "", webSearch = "0", modelId = "3" }) {
  let answer = "", refs = [], errored = null;
  await channels.searchStream({ query, docIds, webSearch, modelId }, (ev) => {
    if (ev.t === "answer") answer += ev.text || "";
    else if (ev.t === "refs") refs = ev.refs;
    else if (ev.t === "error") errored = ev.msg;
  });
  if (errored && !answer) throw new Error("上游错误: " + errored);
  return { answer: answer.trim(), refs };
}

/** 上传文件到 aisearch（统一包装 400102000 审核拦截的友好提示） */
async function uploadForParse(buf, name) {
  try {
    return await channels.uploadSearchDoc(buf, name);
  } catch (e) {
    if (/400102000|敏感内容/.test(String(e.message))) {
      throw new Error("CSDN 上游审核拦截了此文件（400102000）。实测多见于含二维码/推广引流内容的图片——裁掉该区域后重传即可通过；普通截图/文档不受影响。");
    }
    throw e;
  }
}

async function callTool(name, args) {
  if (!registry.isMcpEnabled()) throw new Error("MCP「全模态解析」已在 web 设置面板停用（http://localhost:3010 ⚙ 设置）");
  switch (name) {
    case "parse_file": {
      if (!args.path) throw new Error("path 必填");
      const abs = path.resolve(String(args.path).trim().replace(/^\/tmp(\/|$)/, require("os").tmpdir() + "$1"));
      const buf = fs.readFileSync(abs);
      if (buf.length > 8 * 1024 * 1024) throw new Error("文件超过 8MB 上传上限");
      const name2 = path.basename(abs);
      const ext = (name2.split(".").pop() || "").toLowerCase();
      if (["md", "txt", "json", "csv", "html", "log", "yml", "yaml"].includes(ext) && buf.length <= 30000) {
        const { answer } = await difyAsk({ query: `[文件「${name2}」内容]\n${buf.toString("utf8")}\n[结束]\n\n${args.question || "总结这个文件的内容。"}`, modelId: "3" });
        return answer;
      }
      const up = await uploadForParse(buf, name2);
      const { answer } = await difyAsk({ query: args.question || "总结这个文件的内容。", docIds: String(up.docId) });
      return answer;
    }
    case "analyze_image": {
      if (!args.path) throw new Error("path 必填");
      const buf = fs.readFileSync(path.resolve(args.path));
      const up = await uploadForParse(buf, path.basename(args.path));
      const { answer } = await difyAsk({ query: args.question || "描述这张图片。", docIds: String(up.docId) });
      return answer;
    }
    case "csdn_search": {
      const apiDefault = registry.getWebSearchGlobals().api;
      const webSearch = args.web_search === undefined ? apiDefault : !!args.web_search;
      const { answer, refs } = await difyAsk({ query: String(args.query), webSearch: webSearch ? "1" : "0", modelId: "1" });
      const refLines = refs.length ? "\n\n参考来源：\n" + refs.map((r) => `- ${r.title} ${r.url}`).join("\n") : "";
      return answer + refLines;
    }
    case "fast_chat": {
      const model = args.model || "csdn-v3-0324";
      if (!registry.isModelEnabled(model)) throw new Error(`模型「${model}」已在 web 设置面板停用`);
      if (!DIFY_SET.has(model)) throw new Error(`fast_chat 仅支持 Dify 快模型: ${[...DIFY_SET.keys()].join("/")}`);
      let answer = "";
      await channels.searchStream({ query: String(args.query), webSearch: registry.getWebSearchGlobals().api ? "1" : "0", modelId: DIFY_SET.get(model) }, (ev) => {
        if (ev.t === "answer") answer += ev.text || "";
      });
      return answer.trim();
    }
    default:
      throw new Error("未知工具: " + name);
  }
}

/** JSON-RPC 分发：返回响应对象（通知返回 null）。三传输共用。 */
async function dispatch(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return null;
  const { method, id, params } = msg;
  try {
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
      case "notifications/initialized":
        return null;
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const { name, arguments: args } = params || {};
        try {
          const text = await callTool(name, args || {});
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(text) }], isError: false } };
        } catch (e) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "错误: " + String(e.message || e).slice(0, 300) }], isError: true } };
        }
      }
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      default:
        if (id !== undefined) return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
        return null;
    }
  } catch (e) {
    if (id !== undefined) return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e).slice(0, 300) } };
    return null;
  }
}

module.exports = { SERVER_INFO, TOOLS, dispatch, callTool };
