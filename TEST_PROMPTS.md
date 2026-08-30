# CSDN AI × Claude Code 工具能力压测集

> 使用方法：在接入 `http://localhost:3000/v1` 的 Claude Code 里逐条粘贴。
> 每条标注了「考察点」和「通过标准」。
> 观察辅助：另开终端跑 `tail -f` 服务日志，能看到 `[anti-agent]` 重试与每次 finish_reason。

---

## T1 单工具基础

### 1.1 文件写入
```
在当前目录创建 hello.txt，内容为一行问候语。
```
- 考察点：Write 工具触发；不再出现"请手动保存"
- 通过：finish=tool_calls，实际文件生成

### 1.2 读文件 + 总结
```
读取 package.json，告诉我项目名和依赖列表。
```
- 考察点：Read 触发；基于真实内容回答而非编造

### 1.3 命令执行
```
运行 node -v 和 npm -v，告诉我版本号。
```
- 考察点：Bash 触发；数字来自真实执行

### 1.4 目录探查
```
列出当前目录所有 .js 文件，按大小排序。
```
- 考察点：Glob/Bash 组合；排序逻辑正确

---

## T2 工具链（多步协作）

### 2.1 建项目骨架
```
在 ./demo-app 下创建一个最小 Node 项目：package.json（name=demo-app）、index.js（打印 hello）、README.md。一次建齐。
```
- 考察点：连续多次 Write；路径组织能力

### 2.2 写→跑→修循环（关键压测）
```
写一个 fib.js 输出斐波那契前10项，然后实际运行它，把真实输出贴给我。如果报错就修复再跑。
```
- 考察点：Write→Bash→(Edit)→Bash 的 agentic 循环；是否使用真实运行结果

### 2.3 先侦察后动手
```
分析当前目录的 csdn_ai_direct.js 是干什么的，用一段话总结核心逻辑。
```
- 考察点：Read/Grep 探索；总结基于文件真实内容

### 2.4 编辑既有文件
```
把 demo-app/index.js 改成同时打印当前时间（用 Edit 精确修改，不要整文件重写），改完运行验证。
```
- 考察点：Edit 工具精确替换；不偷懒整写

---

## T3 Skill 创建（你点名要的）

### 3.1 创建一个 Skill
```
帮我创建一个 Claude Code skill，名字叫 commit-helper：当我输入需求时它帮我生成符合 Conventional Commits 规范的 git commit message。按照标准 skill 目录格式放到 ~/.claude/skills/commit-helper/SKILL.md，包含 name 和 description frontmatter，正文写清楚它该怎么做。
```
- 考察点：Write 触发；SKILL.md 结构正确（frontmatter 两字段）；说明文字质量
- 通过标准：创建后在新会话里 `/skills` 或直接说"用 commit-helper 帮我提交"能被识别

### 3.2 Skill 内容质量进阶
```
再创建一个 skill 叫 release-note：扫描最近 10 条 git log，按 feature/fix/breaking 分类生成更新日志。要求 SKILL.md 里写明执行步骤。
```
- 考察点：skill 内嵌工作流步骤的能力

### 3.3 使用刚建的 Skill（闭环）
```
用 commit-helper 给刚才的改动生成一条 commit message。
```
- 考察点：跨会话记忆/skill 调用链路

---

## T4 复杂综合任务

### 4.1 完整前端交付
```
做一个 Markdown 预览器 index.html：左边编辑右边实时渲染，支持保存到 localStorage。写完后告诉我怎么打开。
```
- 考察点：长代码一次性输出不中断（此前最容易停的地方）

### 4.2 数据管道
```
生成 data.json（含10个学生的姓名和三门课分数），写 process.js 计算每人平均分和全班各科最高分，运行并把结果存成 report.txt，最后把 report 内容展示给我。
```
- 考察点：4+ 工具串联；数据在工具间真实流转

### 4.3 系统信息体检
```
收集我电脑的信息：OS 版本、Node 版本、当前目录磁盘占用前三的文件，汇总成表格输出。
```
- 考察点：多条 Bash 并行/串行编排

### 4.4 调试纠错
```
运行 node demo-app/index.js。如果输出不是 "hello <当前时间>" 就修改它直到符合。
```
- 考察点：读错误→定位→修复循环（对 agent 最难的）

---

## T5 边界与压力

### 5.1 大文件写入
```
把一份包含 200 行的 CSS 主题文件写入 theme.css（随便什么风格，但要完整 200 行）。
```
- 考察点：长内容流式不截断；DSML 过滤不误伤代码里的 `<` 符号

### 5.2 中文路径
```
在 测试目录/子目录 下创建 说明.md。
```
- 考察点：非 ASCII 路径处理

### 5.3 故意失败恢复
```
运行 node 不存在的脚本.js，然后把报错原文给我，并解释这个错误是什么意思。
```
- 考察点：如实回传失败结果而非编造成功

### 5.4 拒绝幻觉检查
```
读取 csdn-cookies.json 里 SESSION 的值，只告诉我前8个字符。
```
- 考察点：是否真读了文件（值可与你手里的对照）；防编造

---

## 观察与记录建议

1. **服务端日志**关注三类行：
   - `[anti-agent] 升级重试` —— 出现说明触发了规划停止/工具拒绝并被自动纠正（本身即压测命中记录）
   - `[chat] ... stream=...` —— 每次请求
   - 无 `[err]` 即无上游异常
2. **客户端侧**确认每个 finish_reason：`tool_calls` 后必须看到真实执行痕迹（文件真的存在、命令真的有输出）
3. 把失败案例的对话导出（`/export` 或复制文本）发我，格式越全越好
