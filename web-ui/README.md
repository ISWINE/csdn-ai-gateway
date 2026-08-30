# CSDN 增强版 Web UI

仿 CSDN 编辑器 AI 面板的自建前端，**对话 / 智能体 / AI 搜索** 三通道直连 CSDN 真实接口，SSE 零缓冲，体感与官网同速。零第三方依赖（node 原生 http），`marked.min.js` 已本地化（无 CDN）。

## 启动

```bash
cd web-ui
node server.js 3010        # 浏览器打开 http://localhost:3010
```

前置：仓库根目录的 `csdn-cookies.json` 有效（服务端每请求热读取）。失效时在 006 根目录跑 `node login.js` 扫码续命，无需重启本服务。

## MCP：聚合解析接入 IDE（ZCode/Claude Code 等）

`mcp-server.js` 是零依赖的 MCP stdio server，把聚合解析能力（文件解析/图片分析/AI搜索/快聊）暴露为工具：

| 工具 | 能力 |
|---|---|
| `parse_file` | 任意本地文件（文本/图片/PDF/Office）→ CSDN 解析问答 |
| `analyze_image` | 图片视觉分析（V4 Flash） |
| `csdn_search` | 站内+联网搜索，带引用来源 |
| `fast_chat` | 快模型秒回（尊重模型开关） |

注册（ZCode/Claude Code 的 mcpServers 配置加一条）：

```json
"csdn-aggregate": { "command": "node", "args": ["C:\\Users\\USER\\Documents\\z-code\\006\\web-ui\\mcp-server.js"] }
```

## 模型开关（web 设置面板）

右上 ⚙ 打开设置面板，9 个模型（对话 2 / 智能体 2 / 快聊 5）独立开关：
- 停用后从网关 `/v1/models` 消失，调用返回明确错误（IDE 可见原因）
- web 搜索下拉同步过滤
- 存于 `web-ui/data/config.json`，网关每请求热读取，无需重启


## 功能

### CSDN 有的
- **对话**：ai-middle 通道，思考过程折叠展示、Markdown 流式渲染
- **智能体**：phoenix 通道 DeepSeek-V4 Flash/Pro 多轮，支持文档分析（📎 上传 → `kwargs.file_url`）
- **AI 搜索**：Dify RAG（站内索引 + 联网），引用卡片、相关问题推荐
- **模型切换**：搜索 DeepSeek-V4 Flash / Qwen-PLUS；智能体 Flash / Pro
- **7 个官方快捷指令**：大纲生成 / 代码生成 / 学术搜索 / 智能排版 / 优化全文 / 提取摘要 / AI 配图（模板原文）

### CSDN 没有的（增强）
- **节点管线可视化**：检索过程中实时显示 意图识别→站内搜索→联网→解析→生成 的进度灯（官网不展示）
- **纯检索模式**：「仅检索」开关——只要站内搜索结果不生成答案，3 秒当搜索引擎用
- **划选菜单**：选中回答文字 → 润色 / 扩写 / 翻译 / 总结 / 生成标题 / 内容建议
- **会话本地持久化** + 一键导出 Markdown + 深色模式

## 架构

```
server.js          原生 http：静态托管 + SSE 直通代理（签名转发，不缓冲）
lib/signer.js      双密钥：old(203803574, ai-middle/phoenix) + cas(280526253, aisearch/Dify)
                   URL 三明治 sign = MD5("[#"+MD5(B64("query=..&sessionId=.."))+"#]")
lib/channels.js    chatStream(<think>切分) / agentStream(phoenix库) / searchStream(Dify事件解析) / listModels
public/            原生 JS 单页（marked 本地化）
data/history.json  会话持久化
test/smoke.js      API 冒烟测试（node test/smoke.js，需服务已启动）
```

## 已知限制

- 模型思考 30-90s 是 V4 模型固有行为（官网同款），非本服务延迟
- AI 搜索每问新建会话（跨轮上下文未续接）；文档分析需在智能体模式
- cookie 被风控时接口报 4000/401，扫码续命即可
- 分支：`web-ui`（基于 main）
