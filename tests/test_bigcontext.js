/**
 * 大上下文截断假设验证：小文件 vs 大文件（40KB 工具结果），对比输出完整性
 */
const fs = require("fs");
const BASE = "http://localhost:3000/v1";

const TOOLS = [{
  type: "function",
  function: {
    name: "Read",
    description: "读取本地文件内容",
    parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
}];

async function chat(messages) {
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-chat", messages, tools: TOOLS }),
  });
  return await r.json();
}

async function round(messages) {
  const j = await chat(messages);
  const ch = j.choices[0];
  return { finish: ch.finish_reason, content: ch.message.content || "", calls: ch.message.tool_calls || null };
}

(async () => {
  // 构造 40KB 大文件
  const big = [];
  for (let i = 0; i < 400; i++) big.push(`// 段落 ${i}: 这里是一些示例逻辑代码，用于撑大文件体积测试上下文处理。const x${i} = ${i} * 2;`);
  fs.writeFileSync("bigfile.js", big.join("\n"));
  const bigContent = fs.readFileSync("bigfile.js", "utf8");
  console.log("大文件:", bigContent.length, "字\n");

  // ===== 场景 A：小文件（对照）=====
  let messages = [{ role: "user", content: "分析 csdn_ai_direct.js 是干什么的，用一段话总结核心逻辑。" }];
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"file_path":"csdn_ai_direct.js"}' } }] });
  const small = fs.readFileSync("csdn_ai_direct.js", "utf8");
  messages.push({ role: "tool", tool_call_id: "c1", name: "Read", content: small.slice(0, 4000) });
  let r = await round(messages);
  console.log("【A 小上下文】finish:", r.finish, "| content 长度:", r.content.length, "| 前80:", JSON.stringify(r.content.slice(0, 80)));

  // ===== 场景 B：大文件 40KB 回灌 =====
  messages = [{ role: "user", content: "分析 bigfile.js 是干什么的，用一段话总结核心逻辑。" }];
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "Read", arguments: '{"file_path":"bigfile.js"}' } }] });
  messages.push({ role: "tool", tool_call_id: "c2", name: "Read", content: bigContent });
  r = await round(messages);
  console.log("【B 大上下文】finish:", r.finish, "| content 长度:", r.content.length, "| 前80:", JSON.stringify(r.content.slice(0, 80)));

  // ===== 场景 C：大文件 + 截断到 3000 字 =====
  messages = [{ role: "user", content: "分析 bigfile.js 是干什么的，用一段话总结核心逻辑。" }];
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c3", type: "function", function: { name: "Read", arguments: '{"file_path":"bigfile.js"}' } }] });
  messages.push({ role: "tool", tool_call_id: "c3", name: "Read", content: bigContent.slice(0, 1500) + "\n…[省略]…\n" + bigContent.slice(-800) });
  r = await round(messages);
  console.log("【C 截断后】finish:", r.finish, "| content 长度:", r.content.length, "| 前80:", JSON.stringify(r.content.slice(0, 80)));
})();