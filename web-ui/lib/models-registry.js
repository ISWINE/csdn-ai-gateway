/**
 * 模型注册表：全部模型的唯一名册 + 用户开关（web-ui/data/config.json，每请求热读取）
 * 开关默认全开；web 设置面板写、网关/web-ui/MCP 三侧读。
 */
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "..", "data", "config.json");

/** 全量模型名册（gateway 模型名 → 展示信息）；aisearchId 用于 web 搜索下拉的映射 */
const ALL_MODELS = {
  "deepseek-chat": { label: "DeepSeek-V3 · 思考（ai-middle，带工具/编码主力）", group: "对话", aisearchId: null },
  "deepseek-reasoner": { label: "DeepSeek-R1 · 深思考（ai-middle，带工具）", group: "对话", aisearchId: null },
  "csdn-agent-flash": { label: "Agent Flash（phoenix，V4，多轮/文档）", group: "智能体", aisearchId: null },
  "csdn-agent-pro": { label: "Agent Pro（phoenix，V4 Pro）", group: "智能体", aisearchId: null },
  "csdn-v3-0324": { label: "DeepSeek-V3-0324（Dify，最快）", group: "快聊", aisearchId: "6" },
  "csdn-qwen3-32b": { label: "Qwen3-32B（Dify，快）", group: "快聊", aisearchId: "14" },
  "csdn-qwen3-32b-think": { label: "Qwen3-32B-Thinking（Dify，推理）", group: "快聊", aisearchId: "15" },
  "csdn-qwen-plus": { label: "Qwen-PLUS（Dify，快）", group: "快聊", aisearchId: "2" },
  "csdn-v4-flash": { label: "DeepSeek-V4-Flash（Dify，视觉/文档解析）", group: "快聊", aisearchId: "3" },
};

/** aisearch 模型 id → gateway 模型名（web 搜索下拉过滤用） */
const AISEARCH_TO_GATEWAY = {};
for (const [gw, info] of Object.entries(ALL_MODELS)) {
  if (info.aisearchId && !(info.aisearchId in AISEARCH_TO_GATEWAY)) AISEARCH_TO_GATEWAY[info.aisearchId] = gw;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 1));
}
/** 开关：config.models[id] 未设置 = 开 */
function isModelEnabled(id) {
  if (!ALL_MODELS[id]) return false; // 名册外的一律拒绝
  const cfg = loadConfig();
  const v = cfg.models && cfg.models[id];
  return v === undefined ? true : !!v;
}
function modelSwitches() {
  const cfg = loadConfig();
  const out = {};
  for (const id of Object.keys(ALL_MODELS)) {
    out[id] = cfg.models && cfg.models[id] !== undefined ? !!cfg.models[id] : true;
  }
  return out;
}

/** 全局联网开关：web 与 api（网关快模型/MCP）各自独立；未设置时 web=开、api=关 */
function getWebSearchGlobals() {
  const cfg = loadConfig();
  const ws = cfg.webSearch || {};
  return {
    web: ws.web !== undefined ? !!ws.web : true,
    api: ws.api !== undefined ? !!ws.api : false,
  };
}
function setWebSearchGlobals(web, api) {
  const cfg = loadConfig();
  cfg.webSearch = { web: !!web, api: !!api };
  saveConfig(cfg);
}
/** MCP 总开关：默认开；关闭后 mcp-server 所有工具调用返回错误 */
function isMcpEnabled() {
  const cfg = loadConfig();
  return cfg.mcp && cfg.mcp.enabled !== undefined ? !!cfg.mcp.enabled : true;
}

module.exports = { ALL_MODELS, AISEARCH_TO_GATEWAY, CONFIG_FILE, loadConfig, saveConfig, isModelEnabled, modelSwitches, getWebSearchGlobals, setWebSearchGlobals, isMcpEnabled };
