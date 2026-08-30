/**
 * CSDN 双密钥签名库（web-ui 专用）
 * - OLD（ai-middle / blog）：appKey 203803574，StringToSign 头区只含 key+nonce
 * - CAS（aisearch / Dify 检索）：appKey 280526253，StringToSign 头区四头（key/nonce/signature-headers/timestamp），
 *   且 URL 的 ?sign= 参数参与 path 签名（详见 REPORT.md 第八章）
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KEYS = {
  old: { key: "203803574", secret: "9znpamsyl2c7cdrr9sas0le9vbc3r6ba" },
  cas: { key: "280526253", secret: "673BzMJHuGF8vQBfRyWpTrXwq5rSgRGD" },
};

// cookie 每次请求热读取（与网关同策略，login.js 续命后无需重启）
function uidOf() {
  try { return fs.readFileSync(require("path").join(__dirname, "uid.txt"), "utf8").trim(); } catch (e) {}
  return "";
}

function cookieHeader() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "csdn-cookies.json"), "utf8"))
    .filter((c) => (c.domain || "").includes("csdn.net"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function nonce() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (16 * Math.random()) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function baseHeaders(referer) {
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    Referer: referer,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    Cookie: cookieHeader(),
  };
}

/** 老密钥签名（ai-middle / phoenix）：method\naccept\n""\nct\n""\nx-ca-key\nx-ca-nonce\npath（uid 必带头） */
function oldHeaders(method, url, ct, referer) {
  const u = new URL(url);
  const n = nonce();
  const s = [method.toUpperCase(), "*/*", "", ct, "", `x-ca-key:${KEYS.old.key}`, `x-ca-nonce:${n}`, u.pathname].join("\n");
  const sig = crypto.createHmac("sha256", KEYS.old.secret).update(s, "utf8").digest("base64");
  return {
    ...baseHeaders(referer),
    "Content-Type": ct,
    uid: uidOf(),
    "x-ca-key": KEYS.old.key,
    "x-ca-nonce": n,
    "x-ca-timestamp": String(Date.now()),
    "x-ca-signature-headers": "x-ca-key,x-ca-nonce",
    "x-ca-signature": sig,
  };
}

/** cas 签名（aisearch）：四头 StringToSign + path?排序query（sign 参数参与） */
function casHeaders(method, url, ct, referer) {
  const u = new URL(url);
  const path = u.pathname;
  const params = {};
  u.searchParams.forEach((v, k) => { params[k] = v; });
  const ts = Date.now(), n = nonce();
  const sigHeadersVal = "x-ca-key,x-ca-nonce,x-ca-signature-headers,x-ca-timestamp";
  const stsHeads = { "x-ca-key": KEYS.cas.key, "x-ca-nonce": n, "x-ca-signature-headers": sigHeadersVal, "x-ca-timestamp": String(ts) };
  let sts = `${method.toUpperCase()}\n*/*\n\n${ct}\n\n`;
  for (const k of Object.keys(stsHeads).sort()) sts += `${k}:${stsHeads[k]}\n`;
  const q = Object.keys(params).sort();
  sts += q.length ? path + "?" + q.map((k) => (params[k] !== "" ? `${k}=${params[k]}` : `${k}`)).join("&") : path;
  const sig = crypto.createHmac("sha256", KEYS.cas.secret).update(sts, "utf8").digest("base64");
  return {
    ...baseHeaders(referer),
    "Content-Type": ct,
    "X-Ca-Key": KEYS.cas.key, "X-Ca-Nonce": n, "X-Ca-Signature-Headers": sigHeadersVal,
    "X-Ca-Timestamp": String(ts), "X-Ca-Signature": sig,
  };
}

/** URL 三明治 sign：MD5("[#" + MD5(Base64(非空字段按序拼 kv)) + "#]") */
function qsSign(obj, fields) {
  const kv = [];
  for (const f of fields) {
    const v = obj[f];
    if (v) kv.push(`${f}=${String(v).trim()}`);
  }
  const b64s = Buffer.from(kv.join("&"), "utf8").toString("base64");
  const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
  return md5(`[#${md5(b64s)}#]`);
}

module.exports = { KEYS, cookieHeader, nonce, oldHeaders, casHeaders, qsSign };
