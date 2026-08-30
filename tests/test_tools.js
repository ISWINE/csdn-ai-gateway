/**
 * 工具调用闭环测试
 */
const BASE = "http://localhost:3000/v1";

async function chat(body) {
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return j = await r.json(), j;
}

const TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "查询指定城市当前天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "城市名" } },
      required: ["city"],
    },
  },
}];

(async () => {
  // 第1步：应发起 tool_calls
  console.log("=== 第1步：模型应发起 tool_calls ===");
  const r1 = await chat({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "北京今天天气怎么样？" }],
    tools: TOOLS,
  });
  const ch1 = r1.choices[0];
  console.log("finish:", ch1.finish_reason);
  console.log("tool_calls:", JSON.stringify(ch1.message.tool_calls, null, 1));
  if (!ch1.message.tool_calls) {
    console.log("content:", ch1.message.content);
    process.exit(1);
  }

  // 第2步：回传工具结果，模型应基于结果回答
  console.log("\n=== 第2步：回传工具结果 ===");
  const r2 = await chat({
    model: "deepseek-chat",
    messages: [
      { role: "user", content: "北京今天天气怎么样？" },
      ch1.message,
      { role: "tool", tool_call_id: ch1.message.tool_calls[0].id, name: "get_weather", content: '{"city":"北京","weather":"晴","temp":"32℃","wind":"南风3级"}' },
    ],
    tools: TOOLS,
  });
  const ch2 = r2.choices[0];
  console.log("finish:", ch2.finish_reason);
  console.log("content:", ch2.message.content);
})().catch(e => { console.error("ERR:", e); process.exit(1); });