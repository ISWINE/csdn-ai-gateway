#!/bin/bash
# CSDN 网关 · Codex 阶段任务运行器（带超时看门狗 + 失败自动重试一次）
# 用法: ./run_stage.sh <工作目录> <超时秒,默认1200> <提示词>
# 说明:
#   - CODEX_HOME 固定用 C:\Users\${USERNAME}\.codex-csdn（独立配置，不影响桌面版）
#   - 事件流写入 <目录>/out_<时间戳>.jsonl，错误写 err_<时间戳>.txt
#   - EXIT=124 表示看门狗超时（任务未完成，但已写文件都会保留，直接发"继续"类提示词接续即可）
#   - 失败(非 124)自动重试一次；再失败则退出码 1
DIR="$1"; TMO="${2:-1200}"; PROMPT="$3"
if [ -z "$DIR" ] || [ -z "$PROMPT" ]; then echo "用法: $0 <工作目录> <超时秒> <提示词>"; exit 1; fi
cd "$DIR" || exit 1
export CODEX_HOME="C:\\Users\\${USERNAME}\\.codex-csdn"
export CSDN_GATEWAY_KEY="local"
TS=$(date +%H%M%S)

run_once() {
  timeout -k 10 "$TMO" codex exec --json --skip-git-repo-check "$PROMPT" < /dev/null > "out_$TS.jsonl" 2> "err_$TS.txt"
  echo $?
}

echo "[run_stage] 开始（超时 ${TMO}s）：${PROMPT:0:60}..."
EXIT=$(run_once)
if [ "$EXIT" != "0" ] && [ "$EXIT" != "124" ]; then
  echo "[run_stage] 异常退出(EXIT=$EXIT)，10 秒后自动重试一次"
  sleep 10
  TS="${TS}r"
  EXIT=$(run_once)
fi

echo "[run_stage] 结束 EXIT=$EXIT"
# 提取最后一轮摘要
LAST_MSG=$(node -e "
const fs=require('fs');
let d='';try{d=fs.readFileSync('out_$TS.jsonl','utf8')}catch(e){process.exit(0)}
let last='';
for(const line of d.trim().split('\n')){ if(!line)continue; try{const j=JSON.parse(line);
  if(j.type==='item.completed'&&j.item&&j.item.type==='agent_message')last=j.item.text;
}catch{}}
console.log(last.replace(/\n+/g,' | ').slice(0,300));
" 2>/dev/null)
echo "[run_stage] 最终回答: ${LAST_MSG:-（无）}"
exit $([ "$EXIT" = "0" ] && echo 0 || echo 1)
