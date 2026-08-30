/**
 * 多轮 agentic 循环模拟：本地扮演工具执行层，复现 2.1 建项目骨架场景
 * 验证模型能否连续发起 mkdir → 3×Write 直到任务完成
 */
const { execSync } = require("child_process");
const fs = require("fs");

const BASE = "http://localhost:3000/v1";

const TOOLS = [
  { type: "function", function: { name: "Bash", description: "执行 shell 命令并返回输出", parameters: { type: "object", properties: { command: { type: "string", description: "要执行的命令" } }, required: ["command"] } } },
  { type: "function", function: { name: "Write", description: "将内容写入本地文件（覆盖）", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } } },
];

// 本地真实执行层
function execute(name, args) {
  if (name === "Bash") {
    try {
      const out = execSync(args.command, { encoding: "utf8", timeout: 15000 });
      return `Done.\n${out || ""}`;
    } catch (e) {
      return `Error: ${e.message.slice(0, 200)}`;
    }
  }
  if (name === "Write") {
    fs.mkdirSync(require("path").dirname(args.file_path), { recursive: true });
    fs.writeFileSync(args.file_path, args.content);
    return `File created: ${args.file_path} (${args.content.length} chars)`;
  }
  return `Unknown tool: ${name}`;
}

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
    { role: "user", content: "写一个 fib.js 输出斐波那契前10项，然后实际运行它，把真实输出贴给我。如果报错就修复再跑。" },
  ];
  let round = 0;
  while (round++ < 10) {
    console.log(`\n===== 第 ${round} 轮 =====`);
    const j = await chat(messages);
    const ch = j.choices[0];
    console.log("finish:", ch.finish_reason);

    if (ch.finish_reason !== "tool_calls") {
      console.log("最终回答:", (ch.message.content || "").slice(0, 300));
      // 物理验证
      console.log("\n=== 磁盘验证 ===");
      for (const f of ["fib.js"]) {
        console.log(f, ":", fs.existsSync(f) ? `存在 (${fs.statSync(f).size}B)` : "✗ 不存在");
      }
      break;
    }

    messages.push(ch.message);
    for (const tc of ch.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      console.log(`调用 ${tc.function.name}:`, JSON.stringify(args).slice(0, 100));
      const result = execute(tc.function.name, args);
      console.log("  → 结果:", result.slice(0, 80));
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
    }
  }
})();