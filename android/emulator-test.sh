#!/bin/bash
# 模拟器端到端测试：AVD → 装 APK → 启动 App → adb forward → 逐接口打真实请求
export JAVA_HOME="C:/tools/android-build/jdk/jdk-17.0.20.1+1"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="C:/tools/android-sdk"
EMU="$SDK/emulator/emulator.exe"
ADB="$SDK/platform-tools/adb.exe"
AVDMAN="$SDK/cmdline-tools/latest/bin/avdmanager.bat"

echo "== 加速检测 =="
"$EMU" -accel-check 2>&1 | head -3

echo "== 创建 AVD（存在则跳过） =="
echo no | "$AVDMAN" create avd -n test29 -k "system-images;android-29;google_apis;x86_64" -d pixel_4 2>&1 | tail -1

echo "== 启动模拟器（无窗口） =="
("$EMU" -avd test29 -no-window -no-audio -gpu swiftshader_indirect -no-boot-anim -port 5554 > /tmp/emu.log 2>&1 &)

"$ADB" wait-for-device 2>/dev/null
for i in $(seq 1 60); do
  boot=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$boot" = "1" ] && break
  sleep 5
done
echo "== boot_completed=$boot =="

echo "== 安装 APK =="
"$ADB" install -r "C:/Users/${USERNAME}/Documents/z-code/006/android/app/build/outputs/apk/debug/app-debug.apk" 2>&1 | tail -1

echo "== 启动 App =="
"$ADB" shell am start -n com.csdn.aug/.MainActivity 2>&1 | tail -1
sleep 4

echo "== 端口转发 =="
"$ADB" forward --remove tcp:30100 2>/dev/null
"$ADB" forward tcp:30100 tcp:3010
B="http://127.0.0.1:30100"

node -e "
const B = 'http://127.0.0.1:30100';
(async () => {
  const h = await fetch(B + '/api/health'); console.log('[health]', await h.text());
  const m = await (await fetch(B + '/api/models')).json();
  console.log('[models] search=' + (m.search||[]).length, 'agent=' + (m.agent||[]).length);
  const t0 = Date.now();
  let answer = '', err = null, first = null;
  const res = await fetch(B + '/api/chat', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ message: '只回答四个字：安卓正常' }) });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  while (true) { const {done, value} = await reader.read(); if (done) break;
    buf += dec.decode(value, {stream:true}); let i;
    while ((i = buf.indexOf('\n\n')) !== -1) { const f = buf.slice(0, i).trim(); buf = buf.slice(i+2);
      for (const l of f.split('\n')) if (l.startsWith('data:')) { try { const j = JSON.parse(l.slice(5));
        if (first === null && j.t === 'answer') first = ((Date.now()-t0)/1000).toFixed(1);
        if (j.t === 'answer') answer += j.text || '';
        if (j.t === 'error') err = j.msg;
      } catch {} } } }
  console.log('[chat] 首字', first, 's |', JSON.stringify(answer.trim().slice(0, 40)), '| err:', err);
  const s = await (await fetch(B + '/api/auth/status')).json();
  console.log('[cookie]', JSON.stringify({ count: s.count, hasUserToken: s.hasUserToken }));
})();
"
echo "== 完成 =="
