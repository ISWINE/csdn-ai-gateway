# CSDN 增强版 · Android

web-ui 的安卓移植版：WebView + 应用内嵌 NanoHTTPD 本地服务（127.0.0.1:3010），双密钥签名 / 三通道 SSE / cookie 池 / 模型开关全部在手机本地运行，不依赖电脑。

- **最低系统**：Android 10（minSdk 29）
- **功能**：对话 / 智能体 / AI 搜索（RAG 引用）· 模型开关 · 全局联网开关 · Cookie 导入/退出 · 文档/图片上传解析
- **桌面专属**（安卓版隐藏）：编辑器 tab、MCP、本机弹窗扫码

## 构建 APK

本机工具链（已就位）：

| 组件 | 路径 |
|---|---|
| JDK 17（TUNA 镜像） | C:\tools\android-build\jdk\jdk-17.0.20.1+1 |
| Gradle 8.7（华为云/阿里云镜像） | C:\tools\android-build\gradle |
| Android SDK（cmdline-tools + platform-34 + build-tools 34.0.0） | C:\tools\android-sdk |

```bash
# 1) 同步前端资产（web-ui/public → android assets，自动裁剪桌面功能）
node android/sync-assets.cjs

# 2) 构建 debug APK
export JAVA_HOME="C:/tools/android-build/jdk/jdk-17.0.20.1+1"
cd android
cmd //c "C:\tools\android-build\gradle\bin\gradle.bat assembleDebug --no-daemon"
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

Maven 依赖走阿里云镜像（settings.gradle），Gradle 包用华为云/阿里云镜像下载。

## 安装

手机（Android 10+）直接安装 `app-debug.apk`（需允许未知来源）。首次进入即为本机服务 + WebView，cookie 请用「⚙ 设置 → 导入 Cookie」从桌面版 `csdn-cookies.json` 复制导入（JSON 数组或头字符串均可）。

## 与桌面版差异

| 功能 | 桌面 | 安卓 |
|---|---|---|
| 对话/智能体/AI搜索/上传解析/模型开关/全局联网 | ✅ | ✅ |
| 扫码登录（Playwright 弹窗） | ✅ | ❌（用 Cookie 导入替代） |
| 编辑器 tab | ✅ | ❌ |
| MCP / cdn-proxy | ✅ | ❌ |

## 结构

```
android/
├── app/src/main/java/com/csdn/aug/
│   ├── CsdnCore.kt      # Store/CookieJar/Signer(双密钥)/Registry(开关)
│   ├── CsdnChannels.kt  # chat(ai-middle)/agent(phoenix)/search(Dify RAG)+上传
│   ├── WebServer.kt     # NanoHTTPD 路由（3010，SSE 管道流）
│   └── MainActivity.kt  # WebView + 文件选择器
├── app/src/main/assets/www/   # web-ui/public 的安卓裁剪版（sync-assets.cjs 生成）
└── sync-assets.cjs            # 前端同步脚本（改了 web-ui/public 后重跑）
```
