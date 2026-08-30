# CSDN 网关修复补全 — 完整汇报

> 任务：完全修复补全 CSDN AI 网关（研究官方前端交互协议 → 修复 → Codex CLI 从简到繁端到端压测）。
> 本文件由 ZCode 生成，2026-08-28。

---

## 一、结论速览

1. **把 CSDN 官方 AI 的前后端交互协议完整逆向清楚了**（编辑器 AI 面板、双模式、双 V4 模型、7 个按钮提示词全部拿到），并据此给网关新增了一条**干净得多的官方同款对话通道**。
2. **修掉了一个存在已久的吞字 bug**（短答案整段丢失——很可能就是你一直看到的"思考完就停/没输出"的元凶之一），外加 5 处小 bug。
3. 按你的建议**砍掉了臃肿提示词注入**（BASE_RULES 从 3 句砍到 1 句，删除所有与模型天性对抗的禁令），并做了一轮协议实验验证最优组合。
4. **Codex CLI 全链路跑通**（新增 `/v1/responses` 端点——Codex 0.150+ 只讲这一种），从简单问答到 dayjs 真实仓库任务全部通过；Claude Code headless 对照也通过。
5. 全部改动未 commit，留在工作区等你审（`git diff` 即可看全部）。

## 二、协议研究：CSDN 官方 AI 是怎么工作的

（扒了 app-blog 主站 119 个 chunk、编辑器 4 个 chunk、AI 面板 vue3 应用 17 个 chunk、aisearch 前端 22 个 chunk，全部用现有 cookie 实测验证）

### 2.1 架构

- 编辑器（editor.csdn.net）的 AI 面板 = iframe 加载 `https://app-blog.csdn.net/csdn/aiChatNew?agent=1`（独立 Vue3 应用），与编辑器 postMessage 通信（`ai-agent-ask` / `ai-agent-answer-end`）。
- **agent / chat 双模式**（和你补充的一致）。agent 后端是 **Cline/Roo 风格智能体**：`attempt_completion`（交付）、`edit_markdown`（文章补丁 `<op>insert</op><locator_type>append</locator_type><new_text>…`）等工具，前端收 `markdown_editor.patch` / `tool_status` 事件。
- 我们在用的 ai-middle 老通道（`blog_writer_md`）就是官方 chat 模式在用的接口——DSML 是它内部 agent 的工具格式，前端本身不解析 DSML（后端消化）。

### 2.2 实测打通的新接口族（老签名密钥 203803574 全通）

| 接口 | 说明 |
|---|---|
| `GET /blog/phoenix/console/v1/ai/assistant/models` | **agent 双模型**：`DeepSeek-V4-Flash` → `markdown_editor/deepseek-v4-flash`；`DeepSeek-V4-Pro` → `markdown_editor/deepseek-v4-pro` |
| `POST /blog/phoenix/console/v1/stream/ai/assistant/agent-chat` | **agent 流式对话**：query 支持 `[{role,content}]` 标准多轮（实测）；SSE 是 OpenAI 形状 JSON（answer 累积全文 / tool 事件 / usage），结束 `[DONE]`+`[TASK_DONE]` |
| `GET /blog/phoenix/console/v1/ai/assistant/get-config` | 快捷指令配置 |
| `GET /aisearch/v2/api/llm/model/list` | AI 搜索侧模型：DeepSeek-V4-Flash(3)/DeepSeek-V3-0324(6)/Qwen3-32B(14)/Qwen3-32B-Thinking(15)/Qwen-plus(1) |

### 2.3 官方提示词库原文（前端 JS + 后端接口双重确认）

- **chat 按钮**：大纲生成=`帮我写一篇关于[输入主题内容]的技术文章大纲`；代码生成=`请生成一段[输入编程语言]代码，实现以下功能：[输入代码要求]`；学术搜索=`帮我找[输入主题内容]相关的中文文献`
- **agent 快捷指令**（get-config 下发）：智能排版=`自动修正空格、标点及英文大小写`；优化全文=`识别错别字，提供用词优化建议`；提取摘要=`自动根据全文，提取摘要，并插入标题下方`；AI配图=`分析全文,给文章插入Mermaid图表`
- **划选菜单**：润色/扩写/翻译/内容建议/生成标题/生成摘要（完整模板已在前端 JS 中，按需可取）

## 三、网关修复补全清单

### 3.1 新能力

| 能力 | 说明 |
|---|---|
| 新模型 `csdn-agent-flash` / `csdn-agent-pro` | 走 phoenix agent-chat 通道：官方 V4 模型、标准多轮、干净 SSE、无 DSML 污染。无工具请求自动路由；带工具请求仍走 ai-middle（客户端工具必须本地执行） |
| `POST /v1/messages` | Anthropic 协议端点——Claude Code 可直连网关（不再需要 cc-switch 中转），tool_use/tool_result 双向翻译 |
| `POST /v1/responses` | OpenAI Responses 协议端点——**Codex CLI 0.150+ 已移除 chat 协议**，补上后 Codex 全链路可用（自环复用现有管线，零侵入） |
| `phoenix_agent.js` | 新通道客户端库（签名/SSE/事件归一化/正文产物提取/累积转增量） |
| `tests/test_gateway_v2.js` | 6 项自测 |

### 3.2 修掉的 bug

1. **吞字 bug（最重要，存在已久）**：带工具的流式请求，正文经 `toolFilter`→`narrated` 行缓冲，但收尾冲刷条件依赖永远为空的 `held` → **凡不以换行结尾的最后一段正文被整段吞掉**。短答案（"5"、"19"、"已完成。"）全丢。已修：收尾无条件冲刷。
2. **「宣而不做」漏检+误杀**：正则只覆盖部分动词（"检查/确认/重建"漏网）；误杀正常短答（白跑 2 轮重试）。修复：判定条件拓宽+交付标记豁免（已完成/结果如下/```代码块）+ 新增宽松版判定（仅限历史含工具结果时），并给 ladder 加第 3 级最后通牒。
3. **短答案缓冲**：流式带工具请求的正文现在缓冲到 400 字或流结束才放行——「宣而不做」可以**静默重试**，不再向客户端重复输出。
4. **DSML 竖线变体解析**：模型会把标签写成 `<｜｜DSML｜｜invoke>` / `<｜DSML｜invoke>` / `<｜invoke>` 三种变体，旧正则全部漏接 → 已全部改为容忍 `DSML` 字样插在标签中段（三种变体实测全过）。
5. 流式 `missing-summary` 不可达（提前 return）、`finishStream` 双重定义、`think=x?undefined:undefined` 死代码、Responses usage 统计——全清。

### 3.3 提示词重构（按你的建议）

- `BASE_RULES`：3 句砍成 1 句（直接回答+代码放代码块）。
- `TOOL_RULES`：一段话（tool_call 格式+工具可用别拒绝+多步执行规则），删除所有「再次强调/唯一合法格式/禁止 DSML」式与模型对抗的段落。
- **协议实验记录**：我试过把 DSML 设为第一协议（顺应模型天性）——结果模型调用它记忆里的 CSDN 内部工具名（`exec_command`）而非客户端工具，且长 DSML 块易截断全损 → 回退 `<tool_call>` 主协议；DSML 降级为网关静默兜底解析（解析器保留，三种变体通吃）。
- 升级重试文案只在故障发生时注入，保留（这是运行时自愈，不是常驻注入）。

## 四、端到端压测（Codex CLI 0.150.1 + Claude Code 2.1.250）

环境：Codex 用独立 `CODEX_HOME=C:\Users\USER\.codex-csdn`（**你的 Codex 桌面配置完全没动**），`approval_policy=never` + `danger-full-access`，全 headless。

| # | 任务 | 客户端 | 结果 | 耗时 |
|---|---|---|---|---|
| T1 | 一句话解释闭包（无工具） | Codex | ✅ 回答完整、干净退出 | 15.6s |
| T2 | 建 Node 项目（3 文件）+运行验证 | Codex | ✅ 2 次真实工具调用、输出真实 | 46s |
| T3 | 建 data.txt+stats.js→运行→贴真实输出 | Codex | ✅ 先侦察后动手、3 次调用 | 55s |
| T4 | **dayjs 真实仓库**：读插件模式→写 weekdayZh 插件→verify 验证 | Codex | ✅ 10 次调用；撞上 dayjs 源码 ESM 缺扩展名的真实障碍，用 `node:module` registerHooks 优雅解决；输出正确（2026-08-28: 周五） | 232s |
| T5 | greet.js 创建+运行 | Claude Code | ✅ 真实输出、总结如实 | 26s |

回归：`tests/` 6 个脚本全过（agentic 循环/Read 总结/Write/Bash/大上下文/网关 v2），大上下文场景还从此前的"空正文"变成完整总结（吞字修复连带收益）。

### 压测过程中抓到并修复的新故障（都发生在真实任务里）

1. Codex 最终总结被 `missing-summary` 误判，白跑 2 轮重试（T1 首轮 3 分钟卡顿的元凶之一）。
2. T4 首轮：模型 DSML 调 `exec_command`（CSDN 内部工具名）且块截断 → 催生协议回退实验（3.3）。
3. T4 二轮：双竖线 DSML 变体整块泄漏 → 正则容错修复（3.2-4）。
4. T4 三轮：42 字"我重建为 UTF-8，并创建 verify.js"宣布即停 → 宽松判定+缓冲修复（3.2-2/3）。

### 关于审批与超时（你的两个问题）

- **审批**：我无法"感知"交互式 TUI 里的审批弹窗，所以从根上绕开——全部用 headless 模式 + 预授权（Codex `approval_policy=never`，Claude Code `--dangerously-skip-permissions`），审批根本不会弹出。
- **超时**：每个测试硬超时（180-900s 视难度）+ `timeout -k` 兜底 + 后台运行轮询输出。实测抓到过一次「Codex turn 已完成但进程不退」（管道 SIGPIPE 问题，改 JSON 落盘后消失）和一次 600s 超时击杀（那轮是我自己的测试提示词自相矛盾导致模型合理地反复核实——教训：指令必须无矛盾）。

## 四·五、大任务专项实测：OA 办公系统提示词（你点名的场景）

提示词原文：`用nodejs写个oa办公后台管理系统，设计数据库，增删改查，工作流，权限验证`，Codex headless 跑 4 轮迭代，每轮都抓出新问题并修复：

| 轮次 | 暴露的问题 | 修复 |
|---|---|---|
| 1 | 模型把"给出最终成果"理解成把整个系统当正文倾倒（21 万字/条），桌面客户端被冲断 | 升级文案+TOOL_RULES 加"多文件必须逐个用工具写，禁止正文贴代码" |
| 2 | 计划复读循环：模型反复"宣布→停"，任务以 EXIT=0 假完成、零文件 | 升级判定拓宽+静默重试缓冲+ladder 加第 3 级 |
| 3 | 硬约束后模型输出"纯 tool_call 零前言"的新流形状，Responses 适配层 output_index 起跳 1 号位 → codex 收到空回合（"没动静"的又一种死法） | 适配层改为递增 output_index，纯工具调用流实测打通 |
| 4（终） | — | **持续 agentic 工作 12.5 分钟**：环境探测→npm 真实装依赖（express/bcryptjs）→建 package.json/src/db.js/src/auth.js，全程自我纠错（PowerShell 语法自修、写前查重防重复） |

**现实预期**（重要）：这条提示词对任何模型都是大工程；本通道单轮思考 1-3 分钟（免费强制思考档）。一次跑不完属正常——模型会自查已有文件接着建，**直接发「继续」即可续工**。要快速拿到完整系统，建议分阶段提示词（骨架+数据库+认证 → CRUD → 工作流 → 前端），每段都能在单轮内闭环。

## 五、使用说明（新东西怎么用）

```bash
# 网关（老用法不变）
node csdn-ai-server.js 3000

# 新模型（phoenix 通道，纯对话质量最好，无工具）
curl -s localhost:3000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"csdn-agent-pro","messages":[{"role":"user","content":"你好"}]}'

# Claude Code 直连（不再需要 cc-switch）
ANTHROPIC_BASE_URL=http://localhost:3000 claude

# Codex CLI（独立配置已就位，不影响你的桌面版）
CODEX_HOME=C:\Users\USER\.codex-csdn CSDN_GATEWAY_KEY=local codex exec "任务..."
```

## 六、遗留与已知

1. **cookie 时效**：全部通道依赖 `csdn-cookies.json`，失效后 `node login.js` 扫码续命（需人工）。
2. Codex 首行警告 "Model metadata for deepseek-chat not found"——无功能影响（上下文窗口用默认值），可在其配置里显式声明消除。
3. phoenix 通道两模型 `supportThink=false`（思考开关无效）；aisearch 的 Qwen3-32B(Thinking) 等模型是另一个接口族，本次未接入（记录在案，想要可加）。
4. ai-middle 的思考 token 开销大（单轮 reasoning 可达 2 万 token），多轮长任务耗时主要花在这里——通道特性，无解。
5. **所有改动未 commit**：`csdn-ai-server.js`、`csdn_ai_direct.js`（改），`phoenix_agent.js`、`tests/test_gateway_v2.js`、`REPORT.md`、`AGENTS.md`（新/改）——`git diff` 审阅后自行提交即可。

## 七、最终形态：write_file 工具注入 + 分阶段流水线（OA demo 由模型独立完成）

### 7.1 write_file 工具注入（针对"模型用 PowerShell heredoc 写文件"的根治）

heredoc 三坑实测：中文乱码（PS 编码）、长文件截断写坏（db.js 两度损坏）、引号地狱。解法：网关在 `/v1/responses` 层给每次请求**注入一个 `write_file` 原生工具**，模型用它写文件时：
- 参数是 JSON → 无引号/编码/截断问题，node fs 直接落盘 UTF-8；
- 网关从 codex 请求的 `environment_context` 提取 `<cwd>` 解析相对路径 + 越界防护；
- 内部循环（≤8 轮）本地执行并回灌结果后再流式回 codex，对客户端零改动。

配套修复（都由 OA 实测逼出）：
- `<tool_call>` JSON 损伤容错解析（尾逗号/arguments 提取/cmd 字段抢救，离线单测覆盖）；
- 工具名统一映射矫正：模型记忆里的 CSDN 工具名 `exec_command` → codex 的 `shell`（cmd 字符串自动包成 argv 数组），`write_file`/正常调用保真；
- 泄漏的协议碎片不再吐给客户端；TOOL_RULES 明令禁止编造工具名。

### 7.2 分阶段流水线实战（你的原始提示词，代码 100% 由模型写）

`用nodejs写个oa办公后台管理系统…` 拆成 3+2 个小阶段（数据层 → 服务与接口 → 前端），每阶段一个 codex 会话、明确完成标准、文件级 node --check 自检：

| 阶段 | 结果 |
|---|---|
| 1 数据层 | ✅ 独立完成（10.7min），3 文件全过语法检查，自己发现并修复中文乱码 |
| 2 服务与接口 | ✅ 15min 看门狗收尾时 server.js 已完成（13 个路由），seed 被它改成幂等版但没写完用户插入 → 一句"补完 USERS 插入"让它自己补齐 |
| 3 前端 | ✅ index.html（15.8KB 完整 SPA） |
| 集成修复 | ✅ 它自己修了 3 个 bug：静态托管缺失、JWT 密钥两处定义不一致、sign 放 roleId 而 roleRequired 读 role（403 根因） |

**终验全通过**：登录→JWT(payload 含 role:'admin')→用户列表（name/role/department 字段与前端对齐）→请假提交→管理员审批。演示地址 `http://localhost:3001`（admin/admin123、lisi/123456 经理、zhangsan/123456 员工）。

### 7.3 超时问题专项（你问的"一直超时"）

三层真相与对策：
1. **模型轮次慢**是通道本质（强制思考，单轮 30-90s，最多见过 8.2 万字推理）——无解，只能接受；
2. **看门狗上限**从 900s 提到 1200s，并新增 `run_stage.sh`（工作区根目录）：超时看门狗 + 非 124 失败自动重试一次 + 自动提取最终回答；阶段文件都落盘，超时不丢进度，补一句"继续"就能接上；
3. **上游真挂死**：ai-middle 超时从 10 分钟降到 5 分钟 + 自动重试一次（重新签名）；Responses 内部循环的 loopback 调用失败也自动重试一次。exception 层面已有 uncaughtException/unhandledRejection 兜底（不退进程、留日志）。

### 7.4 文档上传与附件分析（你观察到的"上传功能"的完整还原）

实测打通官方上传接口：`POST /blog/phoenix/console/v1/ai/file/doc/upload`（multipart，字段 `docFile`，签名用字面量 `multipart/form-data` 配 `X-Ca-Signed-Content-Type` 头）→ 返回华为 OBS 签名 URL → 官方前端把 URL 填进 agent-chat 的 **`kwargs.file_url`** → 后端 agent **服务端**读文件分析 → edit_markdown 写回编辑器。

**关键结论**：read 类能力是服务端实现的（走 file_url），模型侧不会发出 read DSML——这解释了映射表里 read 工具"没被实际触发"的原因（表里仍保留 read_file 别名作保险）。

**网关新增能力**：csdn-agent-flash/pro 通道支持附件分析——消息里写 `[[file:路径]]`（或 `[[文件:路径]]`），网关自动上传并把 file_url 塞给后端。实测：上传季度报告 md 后模型精准答出文档内的营收数字与风险点。细节：单文件 ≤8MB；Git Bash 风格 `/tmp/...` 路径自动映射到 Windows 临时目录；上传失败会把错误标注在原标记位置。

### 7.5 CSDN 原生工具目录与映射矩阵（你问的"它有几个工具"）

实测捕获 + Cline 血统推断，CSDN agent 外壳的工具远不止 read/write：

| CSDN 工具名 | 证据 | Claude Code 侧 | Codex 侧 |
|---|---|---|---|
| `exec_command`（cmd） | 实测捕获 3+ 次 | Bash | shell（cmd 自动包成 argv 数组） |
| `editor_write`/`write_file` | 实测 + 老注释 | Write | write_file |
| `edit_markdown`（op/locator/new_text） | 实测（agent-chat 探针） | Edit | write_file |
| `read_file`/`view_file` | Cline 系推断 | Read | shell（Get-Content -Raw -Encoding UTF8） |
| `search_files`/`grep_search` | Cline 系推断 | Grep | shell（Get-ChildItem + Select-String） |
| `list_files`/`list_dir` | Cline 系推断 | Bash | shell（Get-ChildItem） |
| `attempt_completion`（params.result） | 实测 | **特判：result 作为最终答案正文，不映射成工具调用** | 同左 |

映射层重构为：精确名匹配 → 别名表（上表）→ 语义兜底 → read/search/list 在只有 shell 的客户端上自动转等价 PowerShell 命令。全矩阵离线单测覆盖（DSML 三种竖线变体 × claude/codex 两套客户端）。

## 八、「学术搜索」真相与 aisearch 接口族逆向（2026-08-29）

> 起因：用户观察到编辑器 AI 面板有「学术搜索」按钮（点击即填入官方模板 `帮我找[输入主题内容]相关的中文文献`），怀疑它调用 CSDN 内部数据库。实测结论：**按钮本身不查任何库，文献是模型现编的；真正的检索在 AI 搜索产品（i-search）的 Dify RAG 管线里，检索源就是 CSDN 自己的博客索引。**

### 8.1 按钮实测：两条对话通道都是纯模型生成

| 通道 | 事件数 | 工具调用 | 检索注入 | 结果 |
|---|---|---|---|---|
| ai-middle（编辑器 chat 在用，即本网关通道） | 867 | 无 | 无 | 模型思考原文："我应该提供检索方法和获取渠道"，随后凭记忆编文献清单 |
| aisearch `stream/chat/answer/completion` | 224 | 无 | **零 references** | 编出《面向微服务架构的分布式事务一致性研究》软件学报 2021、《大规模微服务系统中的服务发现与负载均衡优化》通信学报 2023 等"标题+期刊+年份"俱全的假论文，还编了 GitHub 链接 |

**使用警示**：编辑器「学术搜索」按钮给出的任何"文献"都不可信，引用前必须自行到知网/万方核验。这也解释了为什么它的输出永远没有可点击的真实来源链接。

### 8.2 真检索在哪：AI 搜索产品的 Dify RAG 管线（已打通）

调用链：`POST smart/session/create`（拿 sid）→ `POST stream/smart/chat/message/stream?sign=...`。后端是 **Dify** 工作流（报错原文"dify调用异常"暴露），workflow_id `075efd38-475e-4275-ba49-bcdf0e27dbda`，实测 790KB 流 / 24s。

**工作流节点全录**（node_started 事件）：

```
User Input → 用户输入长度判断 → 计算当前时间 → 判断输入长度 → 获取上一轮对话详情
→ 判断docid → 工具_CSDN意图识别 → 拼接用户历史提问 → 条件分支5 → 是否开启联网
→ ★ csdn站内搜索（http-request）→ 搜索结果解析 → HTTP请求7 → globalUrls
→ 通用对话模型切换 → LLM → 异步上报 → app_csdnSearch(answer) → 变量聚合
→ 二次调用(llm) → related_questions → 直接回复4
```

**`csdn站内搜索` 节点实证**（内部索引 = CSDN 博客库）：
- 索引名 `online_blog_index_reduce_v6`，返回 `blog-<文章id>#<BM25分数>` 列表 + hits[]（含 title/description/author/keyword）
- `搜索结果解析` 节点输出规整引用：`[{id, title, url}]`，全部是 blog.csdn.net 真实文章链接
- 最终 LLM 答案带 `[ref_N]` 引用标注，与检索结果对齐（答案开头即"综合参考资料"）——**真 RAG**，与 8.1 的凭空编造形成对照

**请求体**（aiDifyChat 前端还原）：

```json
{
  "inputs": { "docIds": "", "modelId": "1", "platform": "pc", "url": "", "webSearch": "1" },
  "query": "用户问题",
  "queryId": "", "sessionId": "<sid>", "trace_id": ""
}
```
`webSearch:"1"` 开联网检索；指定 `docIds`（文档分析）时变 "0"。`modelId` 取自 `smart/llm/model/list`：1=DeepSeek-V4 Flash（284B/A13B，支持 thinking 与 1M 上下文）、2=Qwen-PLUS 等。

**SSE 形状**：Dify 原生事件——`workflow_started` / `node_started` / `node_finished` / `message`（增量在顶层 `answer` 字段）/ `message_end`；检索中间产物在 `node_finished.data.outputs` 里可全部取到。

### 8.3 协议情报（双密钥体系与签名差异）

1. **第二套密钥（cas）**：`appKey 280526253 / appSecret 673BzMJHuGF8vQBfRyWpTrXwq5rSgRGD`；bundle 里还有 `search: 280583483 / BnbF0XulehgcOydy9481chYiAMNEbb5c`。老密钥（203803574）在 aisearch 的 `GET smart/llm/model/list`、`POST smart/session/create` 也通——双密钥并存。
2. **X-Ca 签名与 ai-middle 的差异**：
   - StringToSign 的头区为**四个**：`x-ca-key / x-ca-nonce / x-ca-signature-headers / x-ca-timestamp`（按字母序，值为声明串本身）
   - **URL 的 `?sign=` 参数参与 path 签名**（`path?sign=...` 追加在头区之后）
   - 声明头 `x-ca-signature-headers: x-ca-key,x-ca-nonce,x-ca-signature-headers,x-ca-timestamp`
   - 仍是 HMAC-SHA256 → Base64
3. **URL sign 三明治**：`sign = MD5("[#" + MD5(Base64("query=..&queryId=..&sessionId=..")) + "#]")`——按字段顺序拼 kv、空值字段跳过、中文不转 URL 编码直接进 Base64。
4. **坑**：`x-ca-signature-headers` 声明列表必须与实际参与签名的头严格一致，多发 `x-ca-timestamp` 不声明会报 `HMAC signature does not match`。
5. **端点生死簿**：活——`smart/llm/model/list`、`smart/session/create`、`stream/chat/answer/completion`、`stream/smart/chat/message/stream`（Dify）、`session/submitExt`；死（线上 404「没有当前路径」）——`stream/smart/chat/stream`、`smart/session/generate`、`session/submit`（前端 bundle 里有但后端未部署/已下线）。
6. 探测脚本存档于本机 `%TEMP%\csdn-probe\`（probe-dify-chat.js 为完整可用示例）。

### 8.4 对网关的启示

- 网关现有的 csdn-agent-flash/pro（phoenix 通道）与所有按钮提示词模板都**不含检索**；模型在知识盲区会编造。
- 想要"真·检索"能力（如让 Claude Code 能查 CSDN 站内文章），应接 8.2 的 Dify 通道——签名与请求体已全部打通，可作为网关新模型（如 `csdn-search`）的后续增强；检索中间结果（node_finished.outputs）还能单独取来做纯搜索 API。
