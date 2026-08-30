# csdn-ai-gateway

把 **CSDN 网页版 AI 助手**（DeepSeek-V4）封装成本地 **DeepSeek/OpenAI 兼容 API**——任何支持自定义 OpenAI 接口的客户端（Claude Code、ChatBox、LobeChat、openai SDK……）填入地址即可直接使用，完整支持**流式输出、思考链（reasoning_content）、工具调用（function calling）**。

```text
Claude Code / 任意 OpenAI 客户端
        │  OpenAI 协议
        ▼
csdn-ai-server (localhost:3000)   ← 本项目
        │  HMAC-SHA256 签名 + Cookie（X-Ca 网关规范）
        ▼
bizapi.csdn.net/ai-middle/gpt/assistant   ← CSDN AI 后端
```

## 快速开始

```bash
npm install                # 安装依赖（playwright + better-sqlite3 等仅 login 需要）
node login.js              # 首次：弹出浏览器 → 扫码登录 → 自动采集全量 cookie
node csdn-ai-server.js 3000
```

客户端配置：

- API 地址：`http://localhost:3000/v1`
- API Key：任意值
- 模型：`deepseek-chat` / `deepseek-reasoner`

## 特性

- **OpenAI/DeepSeek 兼容**：`/v1/chat/completions`、`stream`、`reasoning_content`、多轮上下文
- **工具调用**：标准 `tools` / `tool_calls` / `role:"tool"` 协议，可接入 Claude Code 等 Agentic 客户端操作本地文件与命令
- **自动扫码续命**：cookie 失效后 `node login.js`，扫码 → 自动采集全量 cookie（含 httpOnly 的 WAF/bot 验证）→ 热生效无需重启
- **健壮性中间层**：对上游六种已知异常（规划式停止 / 零正文 / 宣而不做 / 工具拒绝 / 缺总结 / 内部标记泄漏）自动检测、升级重试与内容抢救

## 工作原理

1. **X-Ca 签名**：还原了 CSDN 前端网关的 HMAC-SHA256 签名算法（`x-ca-key` + `x-ca-nonce` 参与），携带完整 Cookie 伪装浏览器直调后端
2. **SSE 解析**：增量解析上游流式响应，分离 `<think>` 思考过程与正文
3. **协议翻译**：模型的原生 DSML 工具调用、叙述式调用等"方言"统一翻译为标准 `tool_calls`
4. **反故障中间层**：六种异常形态详见 `csdn-ai-server.js` 内的检测表与 `AGENTS.md` 的完整踩坑记录

## 注意事项

- 登录态存在 `csdn-cookies.json`（已被 .gitignore 排除），**切勿提交或分享**；失效后重新跑 `login.js` 即可
- CSDN 对 `think:false`（非思考模式）通道有限流，服务默认走 `think:true`
- 仅供个人学习与自动化研究，请遵守 CSDN 服务条款，勿用于商业或高频滥用场景

## License

MIT
