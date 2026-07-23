// Cloudflare Pages Function — รับไฟล์จากหน้า /send/ → เก็บเข้า repo private ml7-data (inbox/<team>/)
// route: /api/up  (GET=อ่าน log, POST=อัปโหลด)
// env vars ที่ต้องตั้งบน Cloudflare Pages: GH_TOKEN (PAT เขียน ml7-data), UPLOAD_SECRET
const REPO = "savingprivatedint-cmyk/ml7-data";
const TEAMS = ["eq", "pl", "of", "energy"];
const MAX_B64 = 5_800_000;
const ALLOWED_EXT = /\.(xlsx|xls|xlsm|csv|txt|zip|pdf)$/i;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const ghHeaders = (t) => ({ Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "User-Agent": "ml7-portal" });

async function ghGet(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}?ref=main`, { headers: ghHeaders(token) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gh get ${path}: ${r.status}`);
  return r.json();
}
async function ghPut(path, contentB64, message, token, sha) {
  const body = { message, content: contentB64, branch: "main" };
  if (sha) body.sha = sha;
  return fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}`, {
    method: "PUT", headers: ghHeaders(token), body: JSON.stringify(body),
  });
}
function bkkStamp() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const iso = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+07:00`;
  return { stamp, iso };
}
const b64ToUtf8 = (b64) => decodeURIComponent(escape(atob(b64)));
const utf8ToB64 = (str) => btoa(unescape(encodeURIComponent(str)));

export async function onRequestGet(context) {
  const { GH_TOKEN: token, UPLOAD_SECRET: secret } = context.env;
  if (!token || !secret) return json({ error: "not_configured" }, 503);
  if ((context.request.headers.get("x-up-key") || "") !== secret) return json({ error: "unauthorized" }, 401);
  try {
    const f = await ghGet("inbox/log.json", token);
    const log = f ? JSON.parse(b64ToUtf8(f.content)) : [];
    return json({ log });
  } catch (e) { return json({ error: "log_read_failed" }, 500); }
}

export async function onRequestPost(context) {
  const { request } = context;
  const { GH_TOKEN: token, UPLOAD_SECRET: secret } = context.env;
  if (!token || !secret) return json({ error: "not_configured" }, 503);
  if ((request.headers.get("x-up-key") || "") !== secret) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const { team, sender, filename, data } = body || {};
  if (!TEAMS.includes(team)) return json({ error: "bad_team" }, 400);
  if (typeof data !== "string" || !data) return json({ error: "no_data" }, 400);
  if (data.length > MAX_B64) return json({ error: "too_big" }, 413);
  const safeName = String(filename || "file").replace(/[\/\\\x00-\x1f]/g, "_").replace(/\.\./g, "_").slice(0, 120);
  if (!ALLOWED_EXT.test(safeName)) return json({ error: "bad_type" }, 400);
  const safeSender = String(sender || "-").replace(/[<>\x00-\x1f]/g, "").slice(0, 60);
  const { stamp, iso } = bkkStamp();
  const path = `inbox/${team}/${stamp}_${safeName}`;
  const put = await ghPut(path, data, `รับไฟล์จากเว็บ: [${team}] ${safeName} (โดย ${safeSender})`, token);
  if (!put.ok) return json({ error: "store_failed", status: put.status }, 502);
  for (let i = 0; i < 3; i++) {
    try {
      const f = await ghGet("inbox/log.json", token);
      const log = f ? JSON.parse(b64ToUtf8(f.content)) : [];
      log.unshift({ ts: iso, team, file: `${stamp}_${safeName}`, sender: safeSender, status: "pending" });
      const b64 = utf8ToB64(JSON.stringify(log.slice(0, 100), null, 1));
      const r = await ghPut("inbox/log.json", b64, `log: ${safeName}`, token, f ? f.sha : undefined);
      if (r.ok) break;
    } catch {}
  }
  return json({ ok: true, file: `${stamp}_${safeName}` });
}
