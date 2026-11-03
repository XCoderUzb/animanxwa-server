const express = require("express"), cors = require("cors"), crypto = require("crypto"), { MongoClient } = require("mongodb");
const { MONGODB_URI, ADMIN_PASS_1, ADMIN_PASS_2 } = process.env;
if (!MONGODB_URI || !ADMIN_PASS_1 || !ADMIN_PASS_2) { console.error("MONGODB_URI, ADMIN_PASS_1 va ADMIN_PASS_2 kerak"); process.exit(1); }
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update(MONGODB_URI + ADMIN_PASS_2).digest("hex");
const app = express(); app.disable("x-powered-by"); app.set("trust proxy", 1); app.use(cors()); app.use(express.json({ limit: "2mb" }));
let M, P, C, N, D, R; // manga, pages, cfg, bildirishnomalar, qurilmalar, baholar

const sign = o => { const b = Buffer.from(JSON.stringify(o)).toString("base64url"); return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url"); };
const verify = t => { try { const [b, s] = String(t).split("."); const e = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  const o = JSON.parse(Buffer.from(b, "base64url")); return o.exp > Date.now() ? o : null; } catch (e) { return null; } };
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
const adm = lvl => (q, r, n) => { const t = verify((q.headers.authorization || "").replace(/^Bearer /, "")); if (!t || t.lvl < lvl) return r.status(401).json({ error: "Ruxsat yo'q" }); n(); };
const wrap = f => (q, r) => f(q, r).catch(e => { console.error(q.method, q.path, e); r.status(500).json({ error: "Server xatosi" + (q.headers.authorization ? ": " + String(e.message).slice(0, 160) : "") }); });
const str = (v, n) => String(v == null ? "" : v).slice(0, n), num = v => Number.isFinite(+v) ? +v : 0;
const list = (a, n) => (Array.isArray(a) ? a : []).slice(0, 30).map(x => str(x, n));
const clean = b => ({ title: str(b.title, 120), desc: str(b.desc, 4000), author: str(b.author, 120), studio: str(b.studio, 120), year: num(b.year),
  type: ["Manga", "Manhwa", "Manhua", "Novella"].includes(b.type) ? b.type : "Manga", status: b.status == "Tugallangan" ? "Tugallangan" : "Ongoing",
  pay: b.pay == "Obuna" ? "Obuna" : "Bepul", vols: num(b.vols), seasons: num(b.seasons), genres: list(b.genres, 40), tags: list(b.tags, 40), cover: str(b.cover, 300000) });
const nextId = async () => (await C.findOneAndUpdate({ _id: "mid" }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after" })).n;
const bz = async () => ((await C.findOne({ _id: "baza" })) || { list: [] }).list;
const fails = new Map();

app.get("/", (q, r) => r.send("AniManxwa API ishlayapti"));

// --- hamma uchun ---
app.get("/api/manga", wrap(async (q, r) => r.json((await M.find({}).sort({ _id: 1 }).toArray()).map(m => ({ id: m._id, ...m, _id: undefined })))));
app.get("/api/chapter/:m/:c", wrap(async (q, r) => { const p = await P.findOne({ _id: +q.params.c, mid: +q.params.m }); if (!p) return r.status(404).json({ error: "Topilmadi" }); r.json({ pages: p.pages }); }));
app.post("/api/read/:id", wrap(async (q, r) => { await M.updateOne({ _id: +q.params.id }, { $inc: { reads: 1 } }); r.json({ ok: 1 }); }));

// --- admin kirish: parol serverda tekshiriladi ---
app.post("/api/auth", wrap(async (q, r) => {
  const f = fails.get(q.ip) || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 6e5) return r.status(429).json({ error: "Juda ko'p urinish. 10 daqiqadan keyin qayta urining." });
  const pw = (q.body || {}).password || "", lvl = same(pw, ADMIN_PASS_2) ? 2 : same(pw, ADMIN_PASS_1) ? 1 : 0;
  if (!lvl) { fails.set(q.ip, { n: f.n + 1, t: Date.now() }); return r.status(401).json({ error: "Kirish mumkin emas: parol noto'g'ri" }); }
  fails.delete(q.ip); r.json({ token: sign({ lvl, exp: Date.now() + 432e5 }), lvl });
}));

// --- admin: manga va boblar ---
app.post("/api/admin/manga", adm(1), wrap(async (q, r) => { const id = await nextId(); await M.insertOne({ _id: id, ...clean(q.body || {}), reads: 0, chapters: [] }); r.json({ id }); }));
app.put("/api/admin/manga/:id", adm(1), wrap(async (q, r) => { await M.updateOne({ _id: +q.params.id }, { $set: clean(q.body || {}) }); r.json({ ok: 1 }); }));
app.delete("/api/admin/manga/:id", adm(1), wrap(async (q, r) => { const id = +q.params.id; await M.deleteOne({ _id: id }); await P.deleteMany({ mid: id }); await N.deleteMany({ mid: id }); r.json({ ok: 1 }); }));
app.post("/api/admin/manga/:id/chapter", adm(1), wrap(async (q, r) => {
  const b = q.body || {}, mid = +q.params.id, cid = Date.now();
  const pages = (Array.isArray(b.pages) ? b.pages : []).slice(0, 2000).map(p => ({ u: str(p.u || p, 500), w: num(p.w), h: num(p.h) }));
  if (!pages.length) return r.status(400).json({ error: "Sahifalar yo'q" });
  const ch = { id: cid, num: num(b.num), vol: num(b.vol), season: num(b.season), title: str(b.title, 120), at: cid };
  const u = await M.updateOne({ _id: mid }, { $push: { chapters: ch } });
  if (!u.matchedCount) return r.status(404).json({ error: "Manga topilmadi" });
  await P.insertOne({ _id: cid, mid, pages }); notifyChapter(await M.findOne({ _id: mid }), ch); r.json({ id: cid });
}));

// --- bob tahrirlash/o'chirish, ko'rilgan, yoqtirish, reyting ---
app.put("/api/admin/manga/:id/chapter/:cid", adm(1), wrap(async (q, r) => {
  const mid = +q.params.id, cid = +q.params.cid, b = q.body || {}, set = {};
  if (b.num !== undefined) set["chapters.$.num"] = num(b.num);
  if (b.vol !== undefined) set["chapters.$.vol"] = num(b.vol);
  if (b.season !== undefined) set["chapters.$.season"] = num(b.season);
  if (b.title !== undefined) set["chapters.$.title"] = str(b.title, 120);
  if (Object.keys(set).length) { const u = await M.updateOne({ _id: mid, "chapters.id": cid }, { $set: set }); if (!u.matchedCount) return r.status(404).json({ error: "Bob topilmadi" }); }
  if (Array.isArray(b.pages)) {
    const pages = b.pages.slice(0, 2000).map(p => ({ u: str(p.u || p, 500), w: num(p.w), h: num(p.h) }));
    if (!pages.length) return r.status(400).json({ error: "Sahifalar yo'q" });
    await P.updateOne({ _id: cid }, { $set: { pages, mid } }, { upsert: true });
  }
  r.json({ ok: 1 });
}));
app.delete("/api/admin/manga/:id/chapter/:cid", adm(1), wrap(async (q, r) => {
  const mid = +q.params.id, cid = +q.params.cid, mg = await M.findOne({ _id: mid }), ch = mg && (mg.chapters || []).find(c => c.id == cid);
  await M.updateOne({ _id: mid }, { $pull: { chapters: { id: cid } } }); await P.deleteOne({ _id: cid });
  if (ch) await N.deleteMany({ mid, num: ch.num, kind: "chap" }); r.json({ ok: 1 });
}));
app.post("/api/read/:id/:cid", wrap(async (q, r) => { await M.updateOne({ _id: +q.params.id, "chapters.id": +q.params.cid }, { $inc: { reads: 1, "chapters.$.views": 1 } }); r.json({ ok: 1 }); }));
app.post("/api/like/:id/:cid", wrap(async (q, r) => { const d = (q.body || {}).d == -1 ? -1 : 1; await M.updateOne({ _id: +q.params.id, "chapters.id": +q.params.cid }, { $inc: { "chapters.$.likes": d } }); r.json({ ok: 1 }); }));
app.post("/api/rate/:id", wrap(async (q, r) => {
  const id = +q.params.id, b = q.body || {}, uid = str(b.uid, 40), v = Math.min(10, Math.max(1, num(b.v)));
  if (!/^\d{10,40}$/.test(uid)) return r.status(400).json({ error: "uid" });
  await R.updateOne({ _id: id + ":" + uid }, { $set: { mid: id, v } }, { upsert: true });
  const a = (await R.aggregate([{ $match: { mid: id } }, { $group: { _id: null, avg: { $avg: "$v" }, n: { $sum: 1 } } }]).toArray())[0] || { avg: 0, n: 0 };
  await M.updateOne({ _id: id }, { $set: { rating: Math.round(a.avg * 10) / 10, rc: a.n } }); r.json({ rating: a.avg, rc: a.n });
}));

// --- baza (Cloudinary): ko'rish 1-darajadan, qo'shish/o'chirish faqat 2-darajadan ---
app.get("/api/admin/baza", adm(1), wrap(async (q, r) => r.json({ list: await bz() })));
app.post("/api/admin/baza", adm(2), wrap(async (q, r) => {
  const c = str((q.body || {}).cloud, 80).trim(), p = str((q.body || {}).preset, 80).trim();
  if (!c || !p) return r.status(400).json({ error: "Ikkala maydonni to'ldiring" });
  await C.updateOne({ _id: "baza" }, { $push: { list: { cloud: c, preset: p } } }, { upsert: true }); r.json({ list: await bz() });
}));
app.delete("/api/admin/baza/:i", adm(2), wrap(async (q, r) => { const l = await bz(); l.splice(+q.params.i, 1); await C.updateOne({ _id: "baza" }, { $set: { list: l } }, { upsert: true }); r.json({ list: l }); }));

// --- ilova versiyasi (eski versiyalarni to'xtatish) ---
app.get("/api/version", wrap(async (q, r) => { const v = (await C.findOne({ _id: "app" })) || {}; r.json({ min: v.min || 0, url: v.url || "", block: v.block !== false }); }));
app.post("/api/admin/version", adm(2), wrap(async (q, r) => { const b = q.body || {}; await C.updateOne({ _id: "app" }, { $set: { min: num(b.min), url: str(b.url, 500) } }, { upsert: true }); r.json({ ok: 1 }); }));

app.post("/api/admin/shield", adm(2), wrap(async (q, r) => { await C.updateOne({ _id: "app" }, { $set: { block: !!(q.body || {}).on } }, { upsert: true }); r.json({ ok: 1 }); }));

// --- Push (Firebase Cloud Messaging, HTTP v1). FIREBASE_KEY = xizmat hisobi JSON fayli matni ---
let FK = null; try { FK = JSON.parse(process.env.FIREBASE_KEY || ""); } catch (e) { if (process.env.FIREBASE_KEY) console.error("FIREBASE_KEY o'qilmadi (JSON emas)"); }
const slug = t => String(t).toLowerCase().replace(/[ʻ'’‘`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
let gtok = { v: "", exp: 0 };
async function gtoken() {
  if (gtok.v && Date.now() < gtok.exp - 6e4) return gtok.v;
  const now = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" }), claim = b64({ iss: FK.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(FK.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + head + "." + claim + "." + sig });
  const j = await r.json(); if (!j.access_token) throw Error("Google token xatosi: " + (j.error_description || j.error));
  gtok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 }; return gtok.v;
}
async function push(list, msg) {
  const out = { ok: 0, err: [] };
  if (!FK || !list.length) return out;
  let at; try { at = await gtoken(); } catch (e) { out.err.push(e.message); console.error(e.message); return out; }
  const url = `https://fcm.googleapis.com/v1/projects/${FK.project_id}/messages:send`;
  for (let i = 0; i < list.length; i += 10) await Promise.all(list.slice(i, i + 10).map(async t => {
    try {
      const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" }, body: JSON.stringify({ message: { token: t.token, notification: { title: msg.title || "AniManxwa", body: msg.body || "", ...(msg.image ? { image: msg.image } : {}) }, data: { url: msg.url || "" }, android: { priority: "HIGH", notification: { channel_id: "default", color: "#e11d2e", icon: "ic_stat" } } } }) });
      if (r.ok) return out.ok++;
      const j = await r.json().catch(() => ({})), e = j.error || {};
      out.err.push((e.status || r.status) + ": " + (e.message || ""));
      if (e.status == "NOT_FOUND") D.updateOne({ _id: t._id }, { $unset: { token: "" } }).catch(() => {});
    } catch (e) { out.err.push(e.message); }
  }));
  if (out.err.length) console.error("FCM xatolari:", out.err.slice(0, 3));
  return out;
}
const pushAll = async msg => push(await D.find({ token: { $exists: true, $ne: "" } }).project({ token: 1 }).toArray(), msg);
const pushSaved = async (mid, msg) => push(await D.find({ saved: mid, token: { $exists: true, $ne: "" } }).project({ token: 1 }).toArray(), msg);
app.post("/api/admin/pushtest", adm(1), wrap(async (q, r) => {
  if (!FK) return r.status(400).json({ error: "Render'da FIREBASE_KEY yozilmagan" });
  const dv = await D.findOne({ _id: str((q.body || {}).uid, 40) });
  if (!dv || !dv.token) return r.status(400).json({ error: "Bu telefonning tokeni serverga kelmagan: ruxsat berilganmi va ilova google-services.json bilan yig'ilganmi?" });
  const res = await push([{ _id: dv._id, token: dv.token }], { title: "AniManxwa", body: "Sinov bildirishnomasi ✓" });
  if (!res.ok) return r.status(500).json({ error: "FCM: " + (res.err[0] || "noma'lum xato") });
  r.json({ ok: 1 });
}));

// --- bildirishnomalar: qo'lda (admin) va avtomatik (saqlangan mangaga yangi bob) ---
const notifyChapter = (mg, ch) => {
  N.insertOne({ at: Date.now(), kind: "chap", to: "saved", mid: mg._id, title: mg.title, type: mg.type, num: ch.num }).catch(e => console.error("notif:", e.message));
  pushSaved(mg._id, { title: mg.title, body: `${mg.type}ni yangi bobi chiqdi · ${ch.num}-bob chiqdi ✓`, image: /^https?:/.test(mg.cover || "") ? mg.cover : "", url: `animanxwa://${mg.type.toLowerCase()}/${slug(mg.title) || mg._id}/${ch.num}` }).catch(e => console.error("push:", e.message));
};
app.post("/api/dev", wrap(async (q, r) => {
  const b = q.body || {}, id = str(b.uid, 40); if (!/^\d{10,40}$/.test(id)) return r.status(400).json({ error: "uid" });
  await D.updateOne({ _id: id }, { $set: { saved: (Array.isArray(b.saved) ? b.saved : []).slice(0, 500).map(Number).filter(Number.isFinite), at: Date.now(), ...(typeof b.token == "string" && b.token.length > 20 ? { token: str(b.token, 400) } : {}) } }, { upsert: true }); r.json({ ok: 1 });
}));
app.get("/api/notif", wrap(async (q, r) => {
  const dv = await D.findOne({ _id: str(q.query.uid, 40) }), sv = dv ? dv.saved : [];
  r.json((await N.find({ $or: [{ to: "all" }, { to: "saved", mid: { $in: sv } }] }).sort({ at: -1 }).limit(30).toArray()).map(n => ({ ...n, id: String(n._id), _id: undefined })));
}));
app.post("/api/admin/notify", adm(1), wrap(async (q, r) => {
  const b = q.body || {}; if (!str(b.title, 120).trim() && !str(b.body, 1000).trim()) return r.status(400).json({ error: "Matn yozing" });
  await N.insertOne({ at: Date.now(), kind: "msg", to: "all", title: str(b.title, 120), body: str(b.body, 1000), image: str(b.image, 500), btn: b.btnText && b.btnUrl ? { t: str(b.btnText, 40), u: str(b.btnUrl, 500) } : null });
  pushAll({ title: str(b.title, 120), body: str(b.body, 1000), image: /^https?:/.test(b.image || "") ? str(b.image, 500) : "", url: /^animanxwa:/i.test(b.btnUrl || "") ? str(b.btnUrl, 500) : "" }).catch(e => console.error("push:", e.message)); r.json({ ok: 1 });
}));

app.use((e, q, r, n) => r.status(400).json({ error: "Noto'g'ri so'rov" }));
MongoClient.connect(MONGODB_URI).then(async c => {
  const d = c.db("animanxwa"); M = d.collection("manga"); P = d.collection("pages"); C = d.collection("cfg"); N = d.collection("notif"); D = d.collection("dev"); R = d.collection("rates");
  try { await C.updateOne({ _id: "sinov" }, { $set: { t: Date.now() } }, { upsert: true }); await C.deleteOne({ _id: "sinov" }); console.log("MongoDB yozish sinovi: OK"); }
  catch (e) { console.error("MongoDB yozish sinovi XATO. Atlas > Database Access > foydalanuvchiga 'Read and write to any database' huquqini bering:", e.message); }
  try { require("./bot")({ app, M, P, bz, notifyChapter }); } catch (e) { console.error("Bot yuklanmadi (API ishlayveradi):", e.message); }
  app.listen(process.env.PORT || 3000, () => console.log("Server tayyor"));
}).catch(e => { console.error("MongoDB ga ulanib bo'lmadi:", e.message); process.exit(1); });
