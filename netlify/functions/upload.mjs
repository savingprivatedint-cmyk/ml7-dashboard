// ระบบรับไฟล์จากหน้า Portal ปท.7 → เก็บเข้า repo private ml7-data (inbox/<team>/)
// ต้องตั้ง env vars บน Netlify: GH_TOKEN (fine-grained PAT เขียน repo ml7-data), UPLOAD_SECRET
export const config = { path: "/api/up" };

const REPO = "savingprivatedint-cmyk/ml7-data";
const TEAMS = ["eq", "pl", "of"]; // EQ=Equipment, PL=Pipeline, OF=Office — เพิ่มทีมใหม่: เพิ่ม key ที่นี่ + สร้างโฟลเดอร์ inbox/<team>/ ใน repo
const MAX_B64 = 5_800_000; // ~4.3 MB ต่อไฟล์
const ALLOWED_EXT = /\.(xlsx|xls|xlsm|csv|txt|zip|pdf)$/i;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ml7-portal",
});

async function ghGet(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}?ref=main`, { headers: ghHeaders(token) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gh get ${path}: ${r.status}`);
  return r.json();
}

async function ghPut(path, contentB64, message, token, sha) {
  const body = { message, content: contentB64, branch: "main" };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}`, {
    method: "PUT", headers: ghHeaders(token), body: JSON.stringify(body),
  });
  return r;
}

function bkkStamp() {
  // เวลาไทย (UTC+7) รูปแบบ YYYYMMDD_HHMMSS + ISO
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const iso = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+07:00`;
  return { stamp, iso };
}

export default async (req) => {
  const token = process.env.GH_TOKEN, secret = process.env.UPLOAD_SECRET;
  if (!token || !secret) return json({ error: "not_configured" }, 503);
  if ((req.headers.get("x-up-key") || "") !== secret) return json({ error: "unauthorized" }, 401);

  // GET = อ่าน log การส่งไฟล์ล่าสุด
  if (req.method === "GET") {
    try {
      const f = await ghGet("inbox/log.json", token);
      const log = f ? JSON.parse(Buffer.from(f.content, "base64").toString("utf-8")) : [];
      return json({ log });
    } catch (e) {
      return json({ error: "log_read_failed" }, 500);
    }
  }

  if (req.method !== "POST") return json({ error: "method" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const { team, sender, filename, data } = body || {};
  if (!TEAMS.includes(team)) return json({ error: "bad_team" }, 400);
  if (typeof data !== "string" || !data) return json({ error: "no_data" }, 400);
  if (data.length > MAX_B64) return json({ error: "too_big" }, 413);

  const safeName = String(filename || "file").replace(/[\/\\\x00-\x1f]/g, "_").replace(/\.\./g, "_").slice(0, 120);
  if (!ALLOWED_EXT.test(safeName)) return json({ error: "bad_type" }, 400);
  const safeSender = String(sender || "-").replace(/[<>\x00-\x1f]/g, "").slice(0, 60);
  const { stamp, iso } = bkkStamp();
  const path = `inbox/${team}/${stamp}_${safeName}`;

  // 1) เก็บไฟล์
  const put = await ghPut(path, data, `รับไฟล์จากเว็บ: [${team}] ${safeName} (โดย ${safeSender})`, token);
  if (!put.ok) return json({ error: "store_failed", status: put.status }, 502);

  // 2) อัปเดต log (ลองซ้ำถ้าชนกัน)
  for (let i = 0; i < 3; i++) {
    try {
      const f = await ghGet("inbox/log.json", token);
      const log = f ? JSON.parse(Buffer.from(f.content, "base64").toString("utf-8")) : [];
      log.unshift({ ts: iso, team, file: `${stamp}_${safeName}`, sender: safeSender, status: "pending" });
      const b64 = Buffer.from(JSON.stringify(log.slice(0, 100), null, 1), "utf-8").toString("base64");
      const r = await ghPut("inbox/log.json", b64, `log: ${safeName}`, token, f ? f.sha : undefined);
      if (r.ok) break;
    } catch { /* retry */ }
  }
  return json({ ok: true, file: `${stamp}_${safeName}` });
};
