/**
 * 模拟 Claude Code 场景：提供 Write 工具，要求保存文件
 * 验证：模型无论走 <tool_call> 协议还是原生 DSML，都能被转换为标准 tool_calls
 */
const BASE = "http://localhost:3000/v1";

const TOOLS = [{
  type: "function",
  function: {
    name: "Write",
    description: "将内容写入本地文件。每次写入会覆盖原文件。",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "目标文件的绝对路径" },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["file_path", "content"],
    },
  },
}];

async function chat(body) {
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await r.json();
}

(async () => {
  console.log("=== 场景：要求保存贪吃蛇到 snake.html ===");
  const r1 = await chat({
    model: "deepseek-chat",
    messages: [
      { role: "user", content: "写一个贪吃蛇游戏" },
      { role: "assistant", content: "好的，以下是贪吃蛇游戏的 HTML 代码：\n```html\n<!DOCTYPE html>\n<html><head><title>贪吃蛇</title></head><body><h1>蛇</h1></body></html>\n```" },
      { role: "user", content: "帮我把上面的代码保存成 snake.html 文件" },
    ],
    tools: TOOLS,
  });
  const ch1 = r1.choices[0];
  console.log("finish:", ch1.finish_reason);
  if (ch1.message.tool_calls) {
    for (const tc of ch1.message.tool_calls) {
      console.log("tool_call:", tc.function.name);
      const args = JSON.parse(tc.function.arguments);
      console.log("  参数键:", Object.keys(args).join(", "));
      for (const [k, v] of Object.entries(args)) {
        console.log(`  ${k} = ${(typeof v === 'string' ? v.slice(0, 80) : v)}${typeof v === 'string' && v.length > 80 ? `...(${v.length}字)` : ""}`);
      }
    }
    console.log("content:", JSON.stringify(ch1.message.content || "").slice(0, 100));
  } else {
    console.log("未发起工具调用！content:", JSON.stringify((ch1.message.content || "").slice(0, 300)));
  }
})().catch(e => { console.error("ERR:", e); process.exit(1); });