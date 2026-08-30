# AGENTS.md — CSDN AI → OpenAI 兼容网关（项目记忆）

> 本文件随 GitHub 仓库（ISWINE/csdn-ai-gateway，私有）异地备份；误删可 `git checkout AGENTS.md` 恢复。

## 快速操作

```bash
node csdn-ai-server.js 3000        # 启动服务（先清 3000 端口旧进程，见"排障"）
node login.js                      # cookie 失效时：开浏览器→扫码→自动采集全量 cookie→热生效
curl -s localhost:3000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

- Claude Code 已通过 `127.0.0.1:15721` 代理（用户 settings.json）指向本服务，用户正常使用即可
- 也可直连：`ANTHROPIC_BASE_URL=http://localhost:3000 claude -p "..." --allowedTools "Write" "Bash" --dangerously-skip-permissions`（网关原生支持 `/v1/messages`）
- Codex CLI 走 `/v1/responses`（wire_api 必须 responses，chat 已被 Codex 0.150+ 移除）；测试用独立 CODEX_HOME（见 REPORT.md），勿动用户主配置
- 模型名：`deepseek-chat`/`deepseek-reasoner` → ai-middle 老通道（带工具/工具调用协议）；`csdn-agent-flash`/`csdn-agent-pro` → phoenix agent-chat 新通道（官方 V4 模型，仅无工具请求）；`csdn-v3-0324`/`csdn-qwen3-32b`/`csdn-qwen3-32b-think`/`csdn-qwen-plus`/`csdn-v4-flash` → AI 搜索 Dify 通道（**只聊天秒回档**：无工具、联网关、Claude Code 纯问答加速用，`claude -p ... --model csdn-v3-0324`，首字 4-6s，勿用于编码任务）

## 文件地图

| 文件 | 作用 |
|---|---|
| csdn-ai-server.js | 入口：路由、消息→prompt、故障检测与升级重试、三段过滤器链、/v1/messages、/v1/responses 兼容层 |
| csdn_ai_direct.js | 核心库：X-Ca 签名、CSDN 直调、SSE 解析、salvage/sanitize 清洗（DSML 正则容忍竖线变体） |
| phoenix_agent.js | phoenix agent-chat 通道库（CSDN 官方编辑器 AI 同款接口，多轮/V4 模型/正文产物提取） |
| csdn-cookies.json | 全量 cookie jar（**服务端每请求热读取**，改完不用重启） |
| login.js | 扫码登录→自动采集全量 cookie（含 httpOnly） |
| make_cookies.js | 手动 cookie 串→JSON（备用） |
| tests/ | 6 个回归脚本（agentic 循环/Read 总结/Write/Bash/大上下文/网关 v2 自测） |
| TEST_PROMPTS.md | 19 条人工压测提示词（T1-T5 分级） |
| REPORT.md | 2026-08 协议逆向+修复补全完整汇报（前端交互协议/新通道/压测记录） |
| run_stage.sh | Codex 阶段任务运行器（超时看门狗+失败重试，用法见文件头注释） |
| archive/ | 旧浏览器方案与调试产物（弃用，可删） |

## OA demo（Codex 独立构建的成果）

- 位置：`%TEMP%\codex-e2e\t10`（node server.js，监听 3001；node src/seed.js 重置演示数据）
- 账号：admin/admin123（管理员）、lisi/123456（经理）、zhangsan/123456（员工）
- 技术栈：Express + node:sqlite + JWT + bcryptjs；功能：登录/用户/部门 CRUD/请假审批工作流
- 全部代码由 Codex（经本网关）分阶段独立编写，过程见 REPORT.md 第七章

## 安卓 App（android 分支，com.csdn.aug）

- 自研 `RawHttpServer.kt` 承载 3010 端口（**勿回退 NanoHTTPD**：2.3.1 header/body 同包竞态会吞小 POST body → Read timed out，聊天/上传时灵时不灵的根因）
- `WebServer.kt` 路由：/api/*（网页 UI 三通道+上传+历史+cookie）+ **内置 OpenAI 兼容网关 `/v1/models`、`/v1/chat/completions`**（流式/非流式；无 tools；空回答自动重试一次）。模型路由：deepseek-chat/reasoner → ai-middle；csdn-agent-*/deepseek-v4-flash|pro → phoenix；csdn-v3-0324/csdn-qwen3-32b/csdn-qwen3-32b-think/csdn-qwen-plus/csdn-v4-flash → Dify（CsdnChannels.difyChat，think 已切分到 reasoning_content）
- **`/mcp` 端点**：MCP「全模态解析」四工具（parse_file/analyze_image/csdn_search/fast_chat），streamable HTTP；安卓版文件工具用 data_b64 传内容（手机读不到客户端电脑路径）
- 上传协议：body 为 JSON `{name, data(base64)}`；multipart 真实 Content-Type 必须带 boundary（签名仍用字面量 multipart/form-data，否则上游「应用服务内部异常」）
- 前端资产由 `android/sync-assets.cjs` 从 web-ui/public 同步（注入 IS_ANDROID、隐藏扫码按钮；**编辑器面板双端保留**）；改 web-ui 后必须重跑再 build（`android/build-apk.sh`）
- 左侧编辑器（📝 按钮/宽屏默认展开）：Markdown 工具栏（B/I/H/S/列表/代码块/格式/图片/链接/插入/保存）+ Markdown/比对（行级 LCS diff，需先「设为基线」）/预览 三页签；智能体联动：发送自动附全文（edAttach 开关）、≥200 字回复自动追加进编辑器并弹出、气泡带 追加/插入/替换/复制 写回按钮；内容 autosave localStorage
- 实测链路：`android/emulator-test.sh`（AVD→装 APK→adb forward tcp:30100 tcp:3010→逐接口 curl）；前端兼容老内核：app.js 禁用 `??`、`catch{}`、模板字符串慎用

## 直调 CSDN 的协议（csdn_ai_direct.js 已实现）

- `POST https://bizapi.csdn.net/ai-middle/gpt/assistant`
- body: `{"think":true,"content":"提示词","prompt":"","biz_no":"blog","sub_biz_no":"blog_writer_md"}`
- **必带头**：`x-ca-key: 203803574`、`x-ca-nonce`(uuid)、`x-ca-timestamp`、`x-ca-signature-headers: x-ca-key,x-ca-nonce`、`x-ca-signature`、`uid: weixin_XXXXXX`、`Referer: https://app-blog.csdn.net/`、完整 Cookie
- **签名**：`Base64(HMAC-SHA256("9znpamsyl2c7cdrr9sas0le9vbc3r6ba", StringToSign))`
  StringToSign = `METHOD\n Accept\n ""\n ContentType\n ""(date)\n x-ca-key:…\n x-ca-nonce:…\n path`（path 去掉 `https://xxx.csdn.net` 前缀）
- Cookie 必须全量：`.csdn.net` 登录态（SESSION/UserToken/UserInfo）+ **passport.csdn.net 的 bc_bot_*/waf_* bot 验证 cookie**（缺任何一个 → 4000「服务器繁忙」）
- 响应：SSE，`data:{"code":200,"text":"片段"}` … `data:[DONE]`；错误 `{"msg":"…","code":4000}`
- **`think:false` 通道常年限流**（所有 sub_biz_no 都是）→ 永远默认 `think:true`；思考片段以 `<think>…</think>` 包裹，需与正文分离

## phoenix agent-chat 通道（phoenix_agent.js，2026-08 逆向官方前端所得）

- `POST https://bizapi.csdn.net/blog/phoenix/console/v1/stream/ai/assistant/agent-chat`（同款 X-Ca 签名+cookie，Referer/Origin: app-blog.csdn.net）
- body：`{model:"markdown_editor/deepseek-v4-flash"|"deepseek-v4-pro", query:"串"或[{role,content}]标准多轮, request_id:uuid, kwargs:{}, extra_body:{}}`（思考：`extra_body.thinking={type:"enabled"}`，但两模型 supportThink=false 实测无效）
- SSE：`meta.type=answer`（**content 是累积全文非增量**，需自行还原 delta）/ `tool`（`attempt_completion` 等工具 JSON，最终正文常在 `params.result`）/ `usage`；结束 `data:[DONE]`+`data:[TASK_DONE]`
- 模型列表接口：`GET /blog/phoenix/console/v1/ai/assistant/models`；官方快捷指令：`GET .../get-config`（智能排版/优化全文/提取摘要/AI配图提示词原文在 REPORT.md）
- 模型会把 DSML 标签写成**竖线变体**（`<｜｜DSML｜｜invoke>`、`<｜DSML｜invoke>`、`<｜invoke>` 三种）——所有 DSML 正则必须容忍 `DSML` 字样插在标签中段（已改）
- 注意：走此通道的模型倾向调用 CSDN 自家工具名（exec_command 等）→ 客户端工具调用必须走 ai-middle 通道，此通道仅用于纯对话

## Cookie 生命周期

- 失效症状：直调返回空/登录相关内容；或 Claude Code 反复「no visible output」
- 续命：`node login.js` → 可见 Chromium 开登录页 → 用户扫码 → 轮询到 UserToken/UserInfo/SESSION → 自动跳编辑器域签发 AI cookie → 全量写回 csdn-cookies.json → 热生效
- 注意：cookie 文件里必须保留 passport 域的 httpOnly bot cookie（Playwright `context.cookies()` 可直接读到，勿用 document.cookie 思路）

## 反故障机制（csdn-ai-server.js 核心，改动前必读）

CSDN 后端模型 = DeepSeek + Agent 外壳（带内部 DSML 工具格式），输出有六种已知故障形态，服务端全部有检测与自动恢复：

| kind | 触发特征 | 恢复手段 |
|---|---|---|
| plan-stop | 无工具场景，短答+Agent 意图措辞（"我先查看…"） | ANTI_AGENT 升级 |
| empty-gen | 带工具场景，**零正文零调用**（大上下文时服务端截断） | TOOL_ESCALATION"直接输出正文" |
| announced | 宣而不做（"现在一次建齐三个文件"/"我继续读取…"然后停） | CONTINUE_ESCALATION（发调用或作答二选一，含第一人称计划检测） |
| tool-refuse | 声称"环境不允许调用工具" | TOOL_ESCALATION |
| missing-summary | 工具全跑完却不给总结就停 | CONTINUE_ESCALATION（同上二选一） |
| 输出污染 | DSML 写文件指令 / 叙述模仿历史格式 / LaTeX 记号 | salvage 成代码块 / 桥接为真实 tool_call / 规则禁用 |

过滤器链（**必须单向**）：`模型输出 → DSML过滤(salvage/桥接) → think切分 → toolFilter(<tool_call>捕获) → narrated(叙述捕获/伪造结果剔除) → emitPlain → 客户端`

### ⚠️ 两条血泪铁律
1. **过滤器禁止回流**：emit 回调不得再 feed 进任何过滤器（曾致 emitC↔narrated 递归死循环 → 空流/畸形参数）
2. **每次尝试的状态变量（held/gateOpen/fullContent/dsmlCalls…）必须在 try 外声明**：catch 与收尾段要重置它们，声明进 try 会导致 `held is not defined` → 未捕获 → 流被掐空（Claude Code 显示"思考完就停"）

### 其他机制
- 每轮工具结果回传时附**续跑指令**（防"每步一停、谎报完工"），只注入一次（历史里多份会诱发复读）
- 输出层**连续重复行折叠**（防 ×11 复读刷屏）
- 工具结果超 4000 字截断（防大上下文把输出 token 吃光）
- 上游 fetch 带 `AbortSignal.timeout(600000)`（防永久挂起）
- 规则文本含【禁止模仿】清单；历史渲染用 `<previous_action>/<action_result>/<continue_instruction>` 结构化标签（模型不会模仿成输出语气）
- **system 消息被故意忽略**（Claude Code 的系统提示太大）；行为约束都在 BASE_RULES/TOOL_RULES
- `normContent` 兼容 Anthropic 块数组 content（`[{type:"text",text}]`）——Claude Code 实际就发这种，勿回退成只认字符串

## 排障流程

1. `curl localhost:3000/health` → 确认服务活（注意 3000 可能被**孤儿 node 进程**占用旧代码：`netstat -ano | findstr :3000` 找 PID → `taskkill /F /PID x`，或 PowerShell 按 CommandLine 匹配 csdn-ai-server 杀）
2. `curl -sN` 直接打流式端点看原始分片（服务端问题在这一步就能定位）
3. 服务日志四类行：`[chat]`（每请求+末条消息预览）、`[upstream]`（上游字节数/content/reasoning 长度）、`[anti-agent]`（异常类型+第几次升级）、`[err]`（异常）
4. Claude Code 侧异常 → 让用户导出 dump_Claude.txt：重点看 finish_reason、模型是否声称调用了工具、`[anti-agent]` 触发的 kind
5. 协议层疑问 → 直接 curl 15721 代理的 `/v1/messages`（Anthropic 格式，body 用 UTF-8 文件 `--data-binary @file`，Git Bash 直传中文会变 GBK）

## 已知限制（非 bug）

- `max_tokens` 被忽略（CSDN 服务端自控；大上下文偶发思考占满输出 → empty-gen 兜底）
- 偶发 `unrecognized_model`（标题生成的代理瞬断）→ 重试即过
- cookie 有时效 → `node login.js` 扫码续命（全自动）
- 直调 HTTP 依赖完整 bot cookie jar；若 CSDN 改风控，优先怀疑 passport 域 cookie 缺失/过期
