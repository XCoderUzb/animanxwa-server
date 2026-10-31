const express = require("express"), cors = require("cors"), crypto = require("crypto"), { MongoClient } = require("mongodb");
const { MONGODB_URI, ADMIN_PASS_1, ADMIN_PASS_2 } = process.env;
if (!MONGODB_URI || !ADMIN_PASS_1 || !ADMIN_PASS_2) { console.error("MONGODB_URI, ADMIN_PASS_1 va ADMIN_PASS_2 kerak"); process.exit(1); }
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update(MONGODB_URI + ADMIN_PASS_2).digest("hex");
const app = express(); app.disable("x-powered-by"); app.set("trust proxy", 1); app.use(cors()); app.use(express.json({ limit: "2mb" }));
let M, P, C, N, D; // manga, pages, cfg, bildirishnomalar, qurilmalar

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

// --- baza (Cloudinary): ko'rish 1-darajadan, qo'shish/o'chirish faqat 2-darajadan ---
app.get("/api/admin/baza", adm(1), wrap(async (q, r) => r.json({ list: await bz() })));
app.post("/api/admin/baza", adm(2), wrap(async (q, r) => {
  const c = str((q.body || {}).cloud, 80).trim(), p = str((q.body || {}).preset, 80).trim();
  if (!c || !p) return r.status(400).json({ error: "Ikkala maydonni to'ldiring" });
  await C.updateOne({ _id: "baza" }, { $push: { list: { cloud: c, preset: p } } }, { upsert: true }); r.json({ list: await bz() });
}));
app.delete("/api/admin/baza/:i", adm(2), wrap(async (q, r) => { const l = await bz(); l.splice(+q.params.i, 1); await C.updateOne({ _id: "baza" }, { $set: { list: l } }, { upsert: true }); r.json({ list: l }); }));

// --- ilova versiyasi (eski versiyalarni to'xtatish) ---
app.get("/api/version", wrap(async (q, r) => { const v = (await C.findOne({ _id: "app" })) || {}; r.json({ min: v.min || 0, url: v.url || "" }); }));
app.post("/api/admin/version", adm(2), wrap(async (q, r) => { const b = q.body || {}; await C.updateOne({ _id: "app" }, { $set: { min: num(b.min), url: str(b.url, 500) } }, { upsert: true }); r.json({ ok: 1 }); }));

// --- bildirishnomalar: qo'lda (admin) va avtomatik (saqlangan mangaga yangi bob) ---
const notifyChapter = (mg, ch) => N.insertOne({ at: Date.now(), kind: "chap", to: "saved", mid: mg._id, title: mg.title, type: mg.type, num: ch.num }).catch(e => console.error("notif:", e.message));
app.post("/api/dev", wrap(async (q, r) => {
  const b = q.body || {}, id = str(b.uid, 40); if (!/^\d{10,40}$/.test(id)) return r.status(400).json({ error: "uid" });
  await D.updateOne({ _id: id }, { $set: { saved: (Array.isArray(b.saved) ? b.saved : []).slice(0, 500).map(Number).filter(Number.isFinite), at: Date.now() } }, { upsert: true }); r.json({ ok: 1 });
}));
app.get("/api/notif", wrap(async (q, r) => {
  const dv = await D.findOne({ _id: str(q.query.uid, 40) }), sv = dv ? dv.saved : [];
  r.json((await N.find({ $or: [{ to: "all" }, { to: "saved", mid: { $in: sv } }] }).sort({ at: -1 }).limit(30).toArray()).map(n => ({ ...n, id: String(n._id), _id: undefined })));
}));
app.post("/api/admin/notify", adm(1), wrap(async (q, r) => {
  const b = q.body || {}; if (!str(b.title, 120).trim() && !str(b.body, 1000).trim()) return r.status(400).json({ error: "Matn yozing" });
  await N.insertOne({ at: Date.now(), kind: "msg", to: "all", title: str(b.title, 120), body: str(b.body, 1000), image: str(b.image, 500), btn: b.btnText && b.btnUrl ? { t: str(b.btnText, 40), u: str(b.btnUrl, 500) } : null }); r.json({ ok: 1 });
}));

app.use((e, q, r, n) => r.status(400).json({ error: "Noto'g'ri so'rov" }));
MongoClient.connect(MONGODB_URI).then(async c => {
  const d = c.db("animanxwa"); M = d.collection("manga"); P = d.collection("pages"); C = d.collection("cfg"); N = d.collection("notif"); D = d.collection("dev");
  try { await C.updateOne({ _id: "sinov" }, { $set: { t: Date.now() } }, { upsert: true }); await C.deleteOne({ _id: "sinov" }); console.log("MongoDB yozish sinovi: OK"); }
  catch (e) { console.error("MongoDB yozish sinovi XATO. Atlas > Database Access > foydalanuvchiga 'Read and write to any database' huquqini bering:", e.message); }
  try { require("./bot")({ app, M, P, bz, notifyChapter }); } catch (e) { console.error("Bot yuklanmadi (API ishlayveradi):", e.message); }
  app.listen(process.env.PORT || 3000, () => console.log("Server tayyor"));
}).catch(e => { console.error("MongoDB ga ulanib bo'lmadi:", e.message); process.exit(1); });
