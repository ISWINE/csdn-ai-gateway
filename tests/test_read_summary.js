/**
 * 复现 T2.3：Read 工具 → 总结场景，逐轮 dump 服务端返回
 */
const fs = require("fs");
const BASE = "http://localhost:3000/v1";

const TOOLS = [{
  type: "function",
  function: {
    name: "Read",
    description: "读取本地文件内容",
    parameters: { type: "object", properties: { file_path: { type: "string", description: "文件路径" } }, required: ["file_path"] },
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

(async () => {
  const messages = [
    { role: "user", content: "分析当前目录的 csdn_ai_direct.js 是干什么的，用一段话总结核心逻辑。" },
  ];
  for (let round = 1; round <= 6; round++) {
    console.log(`\n===== 第 ${round} 轮 =====`);
    const j = await chat(messages);
    const ch = j.choices[0];
    console.log("finish:", ch.finish_reason);
    const c = ch.message.content || "";
    console.log("content 长度:", c.length, "| 前120字:", JSON.stringify(c.slice(0, 120)));
    if (ch.message.reasoning_content) console.log("reasoning 长度:", ch.message.reasoning_content.length);
    if (ch.message.tool_calls) {
      for (const tc of ch.message.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        console.log("调用:", tc.function.name, JSON.stringify(args).slice(0, 80));
        const content = fs.readFileSync(args.file_path, "utf8");
        console.log("→ 结果: 文件", content.length, "字");
        messages.push(ch.message);
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content });
      }
      continue;
    }
    break;
  }
})();