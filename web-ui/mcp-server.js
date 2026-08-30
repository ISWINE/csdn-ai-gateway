#!/usr/bin/env node
/**
 * CSDN 全模态解析 MCP Server — stdio 传输（零依赖薄壳，逻辑在 lib/mcp-core.js）
 *
 * ZCode/Claude Code 注册：
 *   "csdn-aggregate": { "command": "node", "args": ["C:\\Users\\USER\\Documents\\z-code\\006\\web-ui\\mcp-server.js"] }
 * HTTP/SSE 传输：web-ui server.js 的 /mcp 与 /mcp/sse 端点（注册片段见 web ⚙ 设置）。
 */
const readline = require("readline");
const core = require("./lib/mcp-core");

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  core.dispatch(msg).then((resp) => { if (resp) send(resp); });
});

process.stderr.write(`[csdn-aggregate MCP/stdio] 就绪（parse_file/analyze_image/csdn_search/fast_chat）\n`);
