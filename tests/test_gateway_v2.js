/** 网关 v2 自测：phoenix 通道（流式/非流式）+ /v1/messages + ai-middle 工具回归 */
const BASE = "http://localhost:3000";

async function j(url, opts) { const r = await fetch(url, opts); return { status: r.status, body: await r.text() }; }

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => { console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " | " + extra : ""}`); cond ? pass++ : fail++; };

  // 0. models
  const models = await j(BASE + "/v1/models");
  ok("/v1/models 含 csdn-agent-flash/pro", models.body.includes("csdn-agent-flash") && models.body.includes("csdn-agent-pro"));

  // 1. phoenix 非流式
  const t1 = Date.now();
  const r1 = await j(BASE + "/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "csdn-agent-flash", messages: [{ role: "user", content: "只回答数字：3+4=?" }] }),
  });
  let j1 = {}; try { j1 = JSON.parse(r1.body); } catch {}
  ok("phoenix 非流式", r1.status === 200 && (j1.choices?.[0]?.message?.content || "").includes("7"),
    `${Date.now() - t1}ms 答:${(j1.choices?.[0]?.message?.content || "").slice(0, 30)}`);

  // 2. phoenix 流式（多轮）
  const t2 = Date.now();
  const r2 = await fetch(BASE + "/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "csdn-agent-flash", stream: true, messages: [
      { role: "user", content: "My favorite color is blue." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "What is my favorite color? One word." },
    ] }),
  });
  const txt2 = await r2.text();
  const content2 = [...txt2.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse('"' + m[1] + '"')).join("");
  ok("phoenix 流式多轮", r2.status === 200 && /blue/i.test(content2) && txt2.includes("[DONE]"),
    `${Date.now() - t2}ms 答:${content2.slice(0, 40)}`);

  // 3. /v1/messages 非流式
  const t3 = Date.now();
  const r3 = await j(BASE + "/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "deepseek-chat", max_tokens: 100, messages: [{ role: "user", content: "只回答数字：9+10=?" }] }),
  });
  let j3 = {}; try { j3 = JSON.parse(r3.body); } catch {}
  ok("/v1/messages 非流式", r3.status === 200 && j3.type === "message" && JSON.stringify(j3.content || "").includes("19"),
    `${Date.now() - t3}ms stop:${j3.stop_reason}`);

  // 4. /v1/messages 流式
  const t4 = Date.now();
  const r4 = await fetch(BASE + "/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "csdn-agent-flash", max_tokens: 200, stream: true, messages: [{ role: "user", content: "Reply with exactly: GATEWAY-OK" }] }),
  });
  const txt4 = await r4.text();
  const text4 = [...txt4.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse('"' + m[1] + '"')).join("");
  ok("/v1/messages 流式", r4.status === 200 && txt4.includes("message_start") && txt4.includes("message_stop") && /GATEWAY-OK/.test(text4.replace(/\s+/g, "")),
    `${Date.now() - t4}ms 答:${text4.slice(0, 40).replace(/\n/g, "")}`);

  // 5. ai-middle + 工具回归（模型仍应输出 tool_call）
  const t5 = Date.now();
  const r5 = await j(BASE + "/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Create hello.txt with the text hi." }],
      tools: [{ type: "function", function: { name: "Write", description: "write file", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } } }],
    }),
  });
  let j5 = {}; try { j5 = JSON.parse(r5.body); } catch {}
  const tc5 = j5.choices?.[0]?.message?.tool_calls;
  ok("ai-middle 工具回归", r5.status === 200 && Array.isArray(tc5) && tc5.length > 0,
    `${Date.now() - t5}ms finish:${j5.choices?.[0]?.finish_reason} tool:${tc5 && tc5[0]?.function?.name}`);

  console.log(`\n===== 自测结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("致命:", e); process.exit(1); });
