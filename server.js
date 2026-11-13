const express = require("express"), cors = require("cors"), crypto = require("crypto"), { MongoClient, ObjectId } = require("mongodb");
const { MONGODB_URI, ADMIN_PASS_1, ADMIN_PASS_2 } = process.env;
if (!MONGODB_URI || !ADMIN_PASS_1 || !ADMIN_PASS_2) { console.error("MONGODB_URI, ADMIN_PASS_1 va ADMIN_PASS_2 kerak"); process.exit(1); }
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update(MONGODB_URI + ADMIN_PASS_2).digest("hex");
const app = express(); app.disable("x-powered-by"); app.set("trust proxy", 1); app.use(cors()); app.use(express.json({ limit: "2mb" }));
try { app.use(require("compression")()); } catch (e) { console.log("compression o'rnatilmagan"); }
let MCACHE = { t: 0, j: "" }; // manga ro'yxati 20 soniya xotirada turadi (ko'p foydalanuvchida server tez ishlashi uchun)
app.use((q, r, n) => { if (q.method !== "GET" && /^\/api\/admin\//.test(q.path)) MCACHE.t = 0; n(); });
let M, P, C, N, D, R, A, U, S, SM, SP, SR, L; // manga, pages, cfg, bildirishnomalar, qurilmalar, baholar

const sign = o => { const b = Buffer.from(JSON.stringify(o)).toString("base64url"); return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url"); };
const verify = t => { try { const [b, s] = String(t).split("."); const e = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  const o = JSON.parse(Buffer.from(b, "base64url")); return o.exp > Date.now() ? o : null; } catch (e) { return null; } };
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
const adm = lvl => (q, r, n) => { const t = verify((q.headers.authorization || "").replace(/^Bearer /, "")); if (!t || !(t.lvl >= lvl)) return r.status(401).json({ error: "Ruxsat yo'q" }); n(); };
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
const mlist = async () => { if (Date.now() - MCACHE.t < 20000) return MCACHE.j; const l = (await M.find({}).sort({ _id: 1 }).toArray()).map(m => ({ id: m._id, ...m, _id: undefined })); MCACHE = { t: Date.now(), j: JSON.stringify(l) }; return MCACHE.j; };
app.get("/api/manga", wrap(async (q, r) => { r.set("Content-Type", "application/json; charset=utf-8").set("Cache-Control", "public, max-age=15").send(await mlist()); }));
app.get("/api/chapter/:m/:c", wrap(async (q, r) => { const p = await P.findOne({ _id: +q.params.c, mid: +q.params.m }); if (!p) return r.status(404).json({ error: "Topilmadi" }); r.json({ pages: p.pages }); }));
app.post("/api/read/:id", wrap(async (q, r) => { await M.updateOne({ _id: +q.params.id }, { $inc: { reads: 1 } }); L.insertOne({ m: +q.params.id, d: new Date() }).catch(() => {}); r.json({ ok: 1 }); }));

// --- admin kirish: parol serverda tekshiriladi ---
app.post("/api/auth", wrap(async (q, r) => {
  const f = fails.get(q.ip) || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 6e5) return r.status(429).json({ error: "Juda ko'p urinish. 10 daqiqadan keyin qayta urining." });
  const pw = (q.body || {}).password || "", lvl = same(pw, ADMIN_PASS_2) ? 2 : same(pw, ADMIN_PASS_1) ? 1 : 0;
  if (!lvl) { fails.set(q.ip, { n: f.n + 1, t: Date.now() }); return r.status(401).json({ error: "Kirish mumkin emas: parol noto'g'ri" }); }
  fails.delete(q.ip); r.json({ token: sign({ lvl, exp: Date.now() + 432e5 }), lvl });
}));

// --- admin: manga va boblar ---
app.post("/api/admin/manga", adm(1), wrap(async (q, r) => { const id = await nextId(); await M.insertOne({ _id: id, ...clean(q.body || {}), reads: 0, chapters: [], at: Date.now() }); r.json({ id }); }));
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
app.post("/api/read/:id/:cid", wrap(async (q, r) => { await M.updateOne({ _id: +q.params.id, "chapters.id": +q.params.cid }, { $inc: { reads: 1, "chapters.$.views": 1 } }); L.insertOne({ m: +q.params.id, d: new Date() }).catch(() => {}); r.json({ ok: 1 }); }));
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
app.post("/api/admin/version", adm(2), wrap(async (q, r) => { const b = q.body || {}; const old = (await C.findOne({ _id: "app" })) || {}, set = { min: num(b.min), url: str(b.url, 500) }; if (set.min !== (old.min || 0)) set.relAt = Date.now(); await C.updateOne({ _id: "app" }, { $set: set }, { upsert: true }); r.json({ ok: 1 }); }));

// --- reklama va obuna (premium) ---
const oid = s => { try { return new ObjectId(String(s)); } catch (e) { return null; } };
app.get("/api/ads", wrap(async (q, r) => r.json((await A.find({ active: { $ne: false } }).sort({ at: -1 }).toArray()).map(a => ({ id: String(a._id), kind: a.kind, media: a.media, src: a.src, title: a.title, text: a.text, url: a.url })))));
app.post("/api/ad/:id/:ev", wrap(async (q, r) => { const id = oid(q.params.id); if (id) await A.updateOne({ _id: id }, { $inc: { [q.params.ev == "click" ? "clicks" : "views"]: 1 } }); r.json({ ok: 1 }); }));
app.get("/api/admin/ads", adm(1), wrap(async (q, r) => r.json((await A.find({}).sort({ at: -1 }).toArray()).map(a => ({ ...a, id: String(a._id), _id: undefined })))));
app.post("/api/admin/ad", adm(1), wrap(async (q, r) => {
  const b = q.body || {}; if (!/^https?:\/\//.test(b.src || "")) return r.status(400).json({ error: "Rasm yoki video kerak" });
  await A.insertOne({ at: Date.now(), kind: b.kind == "full" ? "full" : "small", media: b.media == "video" ? "video" : "image", src: str(b.src, 500), title: str(b.title, 80), text: str(b.text, 160), url: str(b.url, 500), active: true, views: 0, clicks: 0 }); r.json({ ok: 1 });
}));
app.put("/api/admin/ad/:id", adm(1), wrap(async (q, r) => { const id = oid(q.params.id); if (id) await A.updateOne({ _id: id }, { $set: { active: !!(q.body || {}).active } }); r.json({ ok: 1 }); }));
app.delete("/api/admin/ad/:id", adm(1), wrap(async (q, r) => { const id = oid(q.params.id); if (id) await A.deleteOne({ _id: id }); r.json({ ok: 1 }); }));
app.get("/api/me", wrap(async (q, r) => { const d = await D.findOne({ _id: str(q.query.uid, 40) }); r.json({ premium: (d && d.premium) || 0 }); }));
app.post("/api/admin/premium", adm(2), wrap(async (q, r) => {
  const b = q.body || {}, id = str(b.uid, 40).replace(/\s/g, ""), days = Math.max(0, num(b.days)); if (!/^\d{10,40}$/.test(id)) return r.status(400).json({ error: "ID noto'g'ri" });
  const d = await D.findOne({ _id: id }), from = Math.max(Date.now(), (d && d.premium) || 0);
  await D.updateOne({ _id: id }, { $set: { premium: days ? from + days * 864e5 : 0 } }, { upsert: true }); r.json({ ok: 1 });
}));
app.get("/api/admin/stats", adm(1), wrap(async (q, r) => {
  const now = Date.now(), day = 864e5, ap = (await C.findOne({ _id: "app" })) || {}, rel = ap.relAt || 0;
  const [total, dau, wau, mau, since, mangaN, agg] = await Promise.all([D.countDocuments({}), D.countDocuments({ at: { $gt: now - day } }), D.countDocuments({ at: { $gt: now - 7 * day } }), D.countDocuments({ at: { $gt: now - 30 * day } }), D.countDocuments({ first: { $gt: rel } }), M.countDocuments({}), M.aggregate([{ $group: { _id: null, r: { $sum: "$reads" }, c: { $sum: { $size: { $ifNull: ["$chapters", []] } } } } }]).toArray()]);
  const builds = await D.aggregate([{ $group: { _id: "$build", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 6 }]).toArray();
  const d0 = new Date(), from = { month: new Date(d0.getFullYear(), d0.getMonth(), 1), year: new Date(d0.getFullYear(), 0, 1) }[q.query.range] || new Date(0);
  const g = await L.aggregate([{ $match: { d: { $gte: from } } }, { $group: { _id: "$m", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  const mgs = await M.find({ _id: { $in: g.map(x => x._id) } }).project({ title: 1, genres: 1 }).toArray(), by = Object.fromEntries(mgs.map(m => [m._id, m])), genres = {};
  g.forEach(x => ((by[x._id] || {}).genres || []).forEach(t => { genres[t] = (genres[t] || 0) + x.n; }));
  r.json({ users: { total, dau, wau, mau, since, relAt: rel }, builds: builds.map(b => ({ b: b._id || 0, n: b.n })), totals: { manga: mangaN, reads: (agg[0] || {}).r || 0, chapters: (agg[0] || {}).c || 0 },
    top: g.slice(0, 10).map(x => ({ id: x._id, title: (by[x._id] || {}).title || "?", n: x.n })), genres: Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => ({ g: x[0], n: x[1] })) });
}));
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
  await D.updateOne({ _id: id }, { $set: { saved: (Array.isArray(b.saved) ? b.saved : []).slice(0, 500).map(Number).filter(Number.isFinite), at: Date.now(), build: num(b.build), ...(typeof b.token == "string" && b.token.length > 20 ? { token: str(b.token, 400) } : {}) }, $setOnInsert: { first: Date.now() } }, { upsert: true }); r.json({ ok: 1 });
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

// ================= CREATOR SAYT: ko'p saytli tizim =================
const GCID = process.env.GOOGLE_CLIENT_ID || "830480285485-ibe59dd1ccljb8lee1kscrfcehps11kp.apps.googleusercontent.com";
const sauth = (q, r, n) => { const t = verify((q.headers.authorization || "").replace(/^Bearer /, "")); if (!t || !t.u) return r.status(401).json({ error: "Avval Google orqali kiring" }); q.uid = t.u; n(); };
const findSite = (q, r, n, mine) => S.findOne({ _id: String(q.params.slug).toLowerCase() }).then(s => {
  if (!s) return r.status(404).json({ error: "Sayt topilmadi" });
  if (mine && s.owner !== q.uid) return r.status(403).json({ error: "Bu sayt sizniki emas" });
  q.site = s; n();
}).catch(() => r.status(500).json({ error: "Server xatosi" }));
const pub = (q, r, n) => findSite(q, r, n, false), own = (q, r, n) => findSite(q, r, n, true);
const sdoc = m => ({ ...m, id: String(m._id), _id: undefined, site: undefined });
const DEFCFG = { accent: "#7c5cff", sections: [{ k: "search", on: true }, { k: "carousel", on: true }, { k: "top", on: true }, { k: "fresh", on: true }, { k: "all", on: true }], items: [{ t: "Obuna olish", u: "https://telegram.me/Shadow_Sxi" }, { t: "Qo'llab-quvvatlash", u: "https://telegram.me/Shadow_Sxi" }] };
const mySites = async uid => (await S.find({ owner: uid }).project({ title: 1, slug: 1 }).toArray()).map(x => ({ slug: x.slug, title: x.title }));

app.post("/api/s/auth", wrap(async (q, r) => {
  const cr = str((q.body || {}).credential, 4000); if (!cr) return r.status(400).json({ error: "Token yo'q" });
  const g = await (await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(cr))).json();
  if (g.aud !== GCID || !g.sub || String(g.email_verified) !== "true") return r.status(401).json({ error: "Google tekshiruvi o'tmadi" });
  await U.updateOne({ _id: g.sub }, { $set: { email: g.email, name: g.name || "", picture: g.picture || "", at: Date.now() } }, { upsert: true });
  r.json({ token: sign({ u: g.sub, exp: Date.now() + 30 * 864e5 }), user: { email: g.email, name: g.name, picture: g.picture }, sites: await mySites(g.sub) });
}));
app.get("/api/s/mine", sauth, wrap(async (q, r) => r.json(await mySites(q.uid))));
app.post("/api/s/create", sauth, wrap(async (q, r) => {
  const b = q.body || {}, name = str(b.name, 40).trim(), slug = name.replace(/['ʻ’‘`]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cloud = str(b.cloud, 80).trim(), own = str(b.ownPreset, 80).trim(), plat = str(b.platPreset, 80).trim();
  if (slug.length < 3) return r.status(400).json({ error: "Sayt nomi kamida 3 ta lotin harf yoki raqamdan iborat bo'lsin" });
  if (["site", "sayt", "admin", "api", "new", "yangi", "login", "app"].includes(slug.toLowerCase())) return r.status(400).json({ error: "Bu nom band" });
  if (!cloud || !own || !plat) return r.status(400).json({ error: "Cloudinary ma'lumotlarini to'liq kiriting" });
  if (b.agree !== true) return r.status(400).json({ error: "Rozilik belgisini qo'ying" });
  if (await S.countDocuments({ owner: q.uid }) >= 3) return r.status(400).json({ error: "Bitta hisobda 3 tagacha sayt bo'lishi mumkin" });
  const u = await U.findOne({ _id: q.uid });
  try { await S.insertOne({ _id: slug.toLowerCase(), slug, title: name, owner: q.uid, email: u && u.email, bases: [{ cloud, preset: own, share: false }, { cloud, preset: plat, share: true }], cfg: DEFCFG, at: Date.now() }); }
  catch (e) { return r.status(409).json({ error: "Bu nomli sayt allaqachon bor" }); }
  await C.updateOne({ _id: "baza" }, { $push: { list: { cloud, preset: plat, site: slug } } }, { upsert: true });
  r.json({ slug });
}));
app.get("/api/s/:slug", pub, (q, r) => r.json({ slug: q.site.slug, title: q.site.title, cfg: q.site.cfg || DEFCFG }));
app.get("/api/s/:slug/manga", pub, wrap(async (q, r) => r.json((await SM.find({ site: q.site._id }).sort({ at: -1 }).toArray()).map(sdoc))));
app.get("/api/s/:slug/chapter/:cid", pub, wrap(async (q, r) => { const p = await SP.findOne({ _id: +q.params.cid, site: q.site._id }); if (!p) return r.status(404).json({ error: "Topilmadi" }); r.json({ pages: p.pages }); }));
app.post("/api/s/:slug/read/:mid/:cid", pub, wrap(async (q, r) => { const id = oid(q.params.mid); if (id) await SM.updateOne({ _id: id, site: q.site._id, "chapters.id": +q.params.cid }, { $inc: { reads: 1, "chapters.$.views": 1 } }); r.json({ ok: 1 }); }));
app.post("/api/s/:slug/rate/:mid", pub, wrap(async (q, r) => {
  const id = oid(q.params.mid), b = q.body || {}, uid = str(b.uid, 40), v = Math.min(10, Math.max(1, num(b.v)));
  if (!id || !/^\d{10,40}$/.test(uid)) return r.status(400).json({ error: "so'rov noto'g'ri" });
  await SR.updateOne({ _id: q.params.mid + ":" + uid }, { $set: { mid: q.params.mid, v } }, { upsert: true });
  const a = (await SR.aggregate([{ $match: { mid: q.params.mid } }, { $group: { _id: null, avg: { $avg: "$v" }, n: { $sum: 1 } } }]).toArray())[0] || { avg: 0, n: 0 };
  await SM.updateOne({ _id: id, site: q.site._id }, { $set: { rating: Math.round(a.avg * 10) / 10, rc: a.n } }); r.json({ ok: 1 });
}));
app.put("/api/s/:slug/cfg", sauth, own, wrap(async (q, r) => {
  const b = q.body || {}, c = b.cfg || {}, keys = ["search", "carousel", "top", "fresh", "all"];
  const sections = (Array.isArray(c.sections) ? c.sections : []).filter(x => keys.includes(x.k)).map(x => ({ k: x.k, on: !!x.on }));
  keys.forEach(k => { if (!sections.find(x => x.k == k)) sections.push({ k, on: true }); });
  await S.updateOne({ _id: q.site._id }, { $set: { title: str(b.title || q.site.title, 40), cfg: { accent: /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : "#7c5cff", sections, items: (Array.isArray(c.items) ? c.items : []).slice(0, 6).map(x => ({ t: str(x.t, 40), u: str(x.u, 300) })).filter(x => x.t) } } }); r.json({ ok: 1 });
}));
app.get("/api/s/:slug/bases", sauth, own, (q, r) => r.json({ list: q.site.bases || [] }));
app.post("/api/s/:slug/bases", sauth, own, wrap(async (q, r) => {
  const b = q.body || {}, cloud = str(b.cloud, 80).trim(), preset = str(b.preset, 80).trim(), share = !!b.share;
  if (!cloud || !preset) return r.status(400).json({ error: "Ikkala maydonni to'ldiring" });
  await S.updateOne({ _id: q.site._id }, { $push: { bases: { cloud, preset, share } } });
  if (share) await C.updateOne({ _id: "baza" }, { $push: { list: { cloud, preset, site: q.site.slug } } }, { upsert: true }); r.json({ ok: 1 });
}));
app.delete("/api/s/:slug/bases/:i", sauth, own, wrap(async (q, r) => {
  const l = q.site.bases || [], b = l[+q.params.i]; if (!b) return r.status(404).json({ error: "Topilmadi" }); l.splice(+q.params.i, 1);
  await S.updateOne({ _id: q.site._id }, { $set: { bases: l } });
  if (b.share) await C.updateOne({ _id: "baza" }, { $pull: { list: { cloud: b.cloud, preset: b.preset, site: q.site.slug } } }); r.json({ ok: 1 });
}));
app.post("/api/s/:slug/manga", sauth, own, wrap(async (q, r) => { const x = await SM.insertOne({ site: q.site._id, at: Date.now(), ...clean(q.body || {}), reads: 0, chapters: [] }); r.json({ id: String(x.insertedId) }); }));
app.put("/api/s/:slug/manga/:id", sauth, own, wrap(async (q, r) => { const id = oid(q.params.id); if (id) await SM.updateOne({ _id: id, site: q.site._id }, { $set: clean(q.body || {}) }); r.json({ ok: 1 }); }));
app.delete("/api/s/:slug/manga/:id", sauth, own, wrap(async (q, r) => { const id = oid(q.params.id); if (id) { await SM.deleteOne({ _id: id, site: q.site._id }); await SP.deleteMany({ mid: String(id), site: q.site._id }); } r.json({ ok: 1 }); }));
app.post("/api/s/:slug/manga/:id/chapter", sauth, own, wrap(async (q, r) => {
  const b = q.body || {}, id = oid(q.params.id), cid = Date.now(), pages = (Array.isArray(b.pages) ? b.pages : []).slice(0, 2000).map(p => ({ u: str(p.u || p, 500), w: num(p.w), h: num(p.h) }));
  if (!id || !pages.length) return r.status(400).json({ error: "Sahifalar yo'q" });
  const u = await SM.updateOne({ _id: id, site: q.site._id }, { $push: { chapters: { id: cid, num: num(b.num), title: str(b.title, 120), at: cid } } });
  if (!u.matchedCount) return r.status(404).json({ error: "Manga topilmadi" });
  await SP.insertOne({ _id: cid, site: q.site._id, mid: String(id), pages }); r.json({ id: cid });
}));
app.delete("/api/s/:slug/manga/:id/chapter/:cid", sauth, own, wrap(async (q, r) => { const id = oid(q.params.id), cid = +q.params.cid; if (id) { await SM.updateOne({ _id: id, site: q.site._id }, { $pull: { chapters: { id: cid } } }); await SP.deleteOne({ _id: cid, site: q.site._id }); } r.json({ ok: 1 }); }));

app.use((e, q, r, n) => r.status(400).json({ error: "Noto'g'ri so'rov" }));
MongoClient.connect(MONGODB_URI).then(async c => {
  const d = c.db("animanxwa"); M = d.collection("manga"); P = d.collection("pages"); C = d.collection("cfg"); N = d.collection("notif"); D = d.collection("dev"); R = d.collection("rates"); A = d.collection("ads"); U = d.collection("users"); S = d.collection("sites"); SM = d.collection("smanga"); SP = d.collection("spages"); SR = d.collection("srates"); L = d.collection("rlog"); L.createIndex({ d: 1 }, { expireAfterSeconds: 34000000 }).catch(() => {});
  try { await C.updateOne({ _id: "sinov" }, { $set: { t: Date.now() } }, { upsert: true }); await C.deleteOne({ _id: "sinov" }); console.log("MongoDB yozish sinovi: OK"); }
  catch (e) { console.error("MongoDB yozish sinovi XATO. Atlas > Database Access > foydalanuvchiga 'Read and write to any database' huquqini bering:", e.message); }
  try { require("./bot")({ app, M, P, bz, notifyChapter }); } catch (e) { console.error("Bot yuklanmadi (API ishlayveradi):", e.message); }
  app.listen(process.env.PORT || 3000, () => console.log("Server tayyor"));
}).catch(e => { console.error("MongoDB ga ulanib bo'lmadi:", e.message); process.exit(1); });
