// 同步 web 前端到安卓 assets/www，并做手机版裁剪（桌面专属功能隐藏）
const fs = require("fs"), path = require("path");
const SRC = path.join(__dirname, "..", "web-ui", "public");
const DST = path.join(__dirname, "app", "src", "main", "assets", "www");
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
function copy(dir, rel) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const s = path.join(dir, f.name), d = path.join(DST, rel, f.name);
    if (f.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, path.join(rel, f.name)); }
    else fs.copyFileSync(s, d);
  }
}
copy(SRC, "");
let html = fs.readFileSync(path.join(DST, "index.html"), "utf8");
// 安卓端：本机弹窗扫码隐藏（无此功能）；网页扫码按钮改为原生网页登录入口（AndroidBridge.openLogin）
html = html.replace('<button class="primary" id="qr2Btn">📱 网页扫码登录（微信）</button>', '<button class="primary" id="qr2Btn">📱 网页登录（扫码/微信/手机号）</button>');
// 4) 注入安卓标记
html = html.replace('<script src="app.js"></script>', '<script>window.IS_ANDROID = true</script>\n<script src="app.js"></script>');
fs.writeFileSync(path.join(DST, "index.html"), html);

console.log("assets synced (editor kept)");
