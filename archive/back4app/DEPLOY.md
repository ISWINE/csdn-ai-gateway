# DEPLOY.md — 网络版部署手册（Back4app 反向隧道）

> 架构：**反向隧道**。Back4app 容器只当"门牌 + 中转"（bridge-server.js），真正的 CSDN 调用发生在你家里（agent.js 回源到本地 csdn-ai-server）。
> 这样 CSDN 看到的永远是你家 IP（cookie 本就是该 IP 签发，规避机房 IP 风控），cookie 也完全不上云。

## 架构与数据流

```
外部客户端（外面的 Claude Code / 手机 / 同事）
      │  HTTPS 公网 URL + Bearer <BRIDGE_TOKEN>（接口与本地完全一致，路径无关代理）
      ▼
Back4app 容器 bridge-server.js（门牌+中转，不碰 CSDN、零敏感信息）
      ▲  ① agent 出站长连接（SSE 下行派活，: ping 15s 防掐）
      │  ② agent POST 回传帧（head/chunk/done/err JSON 信封，b64 逐块）
      │
你家电脑 agent.js ──► http://127.0.0.1:3000（csdn-ai-server 原封不动）
                        │
                        ▼
                  bizapi.csdn.net（看到的是你家 IP ✅）
```

- 前提：**家里电脑开机在线**，云端只是门牌，电脑一关服务就没了
- 自愈：agent 断线指数退避重连（5s→60s）；每 4 分钟 ping `/health` 兼防免费层休眠（容器睡了会被 ping 叫醒后自动重连，冷启动 30-50 秒）
- 分支策略：main = 本地版；`back4app` 分支 = 网络版（本分支）。改动向后兼容，main 的更新 merge 过来即可

## 一、云端部署（只做一次）

> ⚠️ 本节所有命令都在**你自己的电脑上**跑（Git Bash）。Back4app 网页里**不执行任何命令**，你只做一件事：把生成的 token 粘贴进它的环境变量输入框。token 就是个自己造的随机密码，不是 Back4app 发给你的。

1. 生成一密两用的 token（agent 通道鉴权 + 公网 Bearer key）——**本地**跑：

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" | clip
   ```

   已由助手生成过的存放在 `.bridge-token.txt`（已 gitignore），打开复制即可，不必重复生成。

2. Back4app 控制台：Containers → New App → 授权 GitHub → 选仓库 `ISWINE/csdn-ai-gateway`、**分支 `back4app`**、Root 留空
3. Environment Variables 添加一条：**Name** 填 `BRIDGE_TOKEN`，**Value** 粘贴第 1 步的 token（**这是唯一要配的变量，cookie 不需要上云**）
4. 建议开 Auto Deploy；健康检查路径（若有此配置）填 `/health`（桥自答，agent 掉线也不算不健康）
5. Create App，记下域名 `https://<名字>.back4app.app`

   （App 已经建过的情况：进你的 App → Settings → Environment Variables → 添加 `BRIDGE_TOKEN` → Save，Back4app 会提示/自动触发重新部署，等状态变 ready 即生效。）

## 二、本地日常运行（每次用网络版时）

两个终端，或开两个窗口：

```bash
node csdn-ai-server.js 3000                                   # 终端1：本地网关（与本地版用法完全一致）
node agent.js https://<名字>.back4app.app <你的BRIDGE_TOKEN>    # 终端2：隧道端（挂机常驻）
```

agent 日志见 `[agent]` 行；看到「已连上桥」即隧道就绪。**本地网关没跑时 agent 照样连桥，但所有请求会以 502 回给客户端。**

## 三、客户端接入

把 baseURL 指到桥、apiKey 填 BRIDGE_TOKEN 即可，其余与本地版无差别：

```
OpenAI 兼容： https://<名字>.back4app.app/v1   apiKey = <BRIDGE_TOKEN>
Anthropic：   ANTHROPIC_BASE_URL=https://<名字>.back4app.app
```

## 四、验证

```bash
curl https://<名字>.back4app.app/health                 # {"ok":true,"agent":true,...}  agent:true 才算通
curl -sN https://<名字>.back4app.app/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <BRIDGE_TOKEN>" \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

本地回归（不触 CSDN）：`node tests/bridge-e2e.js`（mock 上游 + 桥 + agent 三进程联跑，10 项断言）

## 五、排障

| 症状 | 定位 |
|---|---|
| `/health` 返回 `"agent":false` | 家里 agent.js 没跑 / token 不对 / 家里断网。看 agent 终端 `[agent]` 行 |
| 请求 503 `agent offline` | 桥活着但 agent 不在（同上）；首请求遇冷启动多等 30-50 秒 |
| 请求 502 | 隧道通但本地网关没跑（终端1），或本地上游真的报错——看 agent 转发的错误 message |
| 首请求卡 30-50 秒 | 免费层休眠冷启动，agent 的保活 ping 恢复后会自愈；介意就 UptimeRobot 每 10 分钟 ping `/health`，或升 $5 Shared |
| 流式有 15 秒级卡顿 | 疑似链路代理缓冲，桥已发 `X-Accel-Buffering: no`，观察是否复现再查 |
| 本地网络出国需代理 | Node fetch 不读 HTTPS_PROXY，agent 需要能直连桥地址 |

## 附：直连模式（不推荐，备用）

若不走隧道让云端直接调 CSDN（csdn-ai-server.js 直连镜像仍在镜像里，改 CMD 即可用）：需设 `CSDN_COOKIES_B64`（本地 `node -e "process.stdout.write(require('fs').readFileSync('csdn-cookies.json').toString('base64'))"` 的输出）与 `CSDN_API_KEY`。**但美国机房 IP 大概率触发 CSDN 风控（4000「服务器繁忙」），且 cookie 上云，仅作验证/备用。**
