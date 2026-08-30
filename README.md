# CSDN 增强版 · 安卓 App

CSDN AI 三通道安卓客户端：对话（ai-middle）/ 智能体（phoenix）/ AI 搜索（Dify）。WebView + 内嵌本地服务（端口 3010），局域网内浏览器可访问。

## 功能

- 三通道聊天直连，SSE 流式
- 内置 OpenAI 兼容网关：`/v1/models`、`/v1/chat/completions`（流式/非流式，模型名带 `@middle/@phoenix/@dify` 通道标记）
- `/v1` 文件附件解析、`/api/fast` 工具模式、MCP「全模态解析」（`/mcp`）
- 左侧 Markdown 编辑器（比对/预览/工具栏），智能体生成内容自动同步写回
- 扫码/网页登录（cookie 自动采集）、Cookie 导入导出、模型与 MCP 开关

## 构建

`android/app/src/main/assets/www` 资产已预构建提交，直接编译即可：

```bash
./gradlew assembleDebug
```

## 使用

安装后 App 在 `127.0.0.1:3010` 起本地服务；设置 → 扫码/网页登录，或导入 Cookie。API 接入配置见 App 内「📖 API」面板。
