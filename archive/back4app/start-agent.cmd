@echo off
rem 网络版一键启动：本地网关没跑就开新窗口拉起，然后启动云端隧道端（挂机窗口别关）
cd /d %~dp0
netstat -ano | findstr :3000 | findstr LISTENING >nul || start "csdn-ai-gateway" cmd /k node csdn-ai-server.js 3000
set /p TOKEN=<.bridge-token.txt
node agent.js https://csdnaigateway-3dh2x7f0.b4a.run %TOKEN%
pause
