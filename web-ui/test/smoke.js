// web-ui API 冒烟测试：models / chat / search(完整+纯检索) / agent / history
const BASE = "http://localhost:3010";
const line = (s) => console.log(s);

async function stream(path, body, label, { maxWait = 180000, collect } = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(maxWait) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "", think = 0, refs = 0, nodes = {}, first = null, related = 0, done = false;
  while (true) {
    const { done: rd, value } = await reader.read();
    if (rd) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx).trim(); buf = buf.slice(idx + 2);
      for (const l of frame.split("\n")) {
        if (!l.startsWith("data:")) continue;
        try {
          const j = JSON.parse(l.slice(5));
          if (first === null) first = ((Date.now() - t0) / 1000).toFixed(1);
          if (j.t === "answer") answer += j.text || "";
          else if (j.t === "think") think += (j.text || "").length;
          else if (j.t === "refs") { refs = j.refs.length; collect && collect.refs.push(...j.refs); }
          else if (j.t === "node") nodes[j.title] = j.state;
          else if (j.t === "related") related = j.items.length;
          else if (j.t === "done") done = true;
          else if (j.t === "error") { line(`  [${label}] ERROR: ${j.msg}`); }
        } catch {}
      }
    }
  }
  line(`[${label}] 首事件 ${first}s | 总 ${((Date.now() - t0) / 1000).toFixed(1)}s | think=${think}字 | answer=${answer.length}字 | refs=${refs} | related=${related} | done=${done}`);
  if (Object.keys(nodes).length) line(`  节点: ${Object.entries(nodes).map(([k, v]) => `${k}:${v}`).join(" | ").slice(0, 300)}`);
  return { answer, refs };
}

(async () => {
  // 0. health + 静态
  const h = await (await fetch(BASE + "/api/health")).json();
  line(`[health] ok=${h.ok}`);
  const page = await (await fetch(BASE + "/")).text();
  line(`[静态页] ${page.includes("CSDN") && page.includes("marked.min.js") ? "OK" : "MISSING"}`);

  // 1. models
  const m = await (await fetch(BASE + "/api/models")).json();
  line(`[models] search=${(m.search || []).length} 个 | agent=${(m.agent || []).length} 个 ${m.searchError || ""}`);

  // 2. chat（短问题）
  await stream("/api/chat", { message: "只回答四个字：接口正常" }, "chat");

  // 3. search 完整（RAG）
  const col = { refs: [] };
  const r = await stream("/api/search", { query: "CSDN 增强版 web ui 怎么用", webSearch: "1", modelId: "1" }, "search", { collect: col, maxWait: 150000 });
  if (col.refs.length) line(`  ref 示例: ${col.refs[0].title} → ${col.refs[0].url.slice(0, 60)}`);

  // 4. 纯搜索模式
  const col2 = { refs: [] };
  await stream("/api/search", { query: "nodejs mysql 连接池", webSearch: "1", pure: true }, "search-pure", { collect: col2, maxWait: 90000 });
  line(`  纯检索 refs=${col2.refs.length} answer 应接近 0`);

  // 5. agent（flash）
  await stream("/api/agent", { messages: [{ role: "user", content: "只回答四个字：通道正常" }], model: "csdn-agent-flash" }, "agent", { maxWait: 120000 });

  // 6. history
  await fetch(BASE + "/api/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "smoke1", title: "冒烟测试", mode: "chat", messages: [{ role: "user", content: "hi" }] }) });
  const db = await (await fetch(BASE + "/api/history")).json();
  line(`[history] sessions=${db.sessions.length}`);
  await fetch(BASE + "/api/history/smoke1", { method: "DELETE" });
})();
