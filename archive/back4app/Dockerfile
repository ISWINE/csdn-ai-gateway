# 网络版镜像（Back4app Containers 用）：只跑桥（公网门面+隧道服务端），不碰 CSDN、不需要 cookie。
# 真正的 CSDN 调用发生在你家里（agent.js 回源），详见 DEPLOY.md。运行时零第三方依赖，无需 npm install。
FROM node:20-slim
WORKDIR /app
COPY package.json csdn-ai-server.js csdn_ai_direct.js bridge-server.js agent.js ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "bridge-server.js"]
