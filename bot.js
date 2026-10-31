// Telegram bot: manga boblarini yuklash. Webhook orqali, Render'dagi shu xizmatning ichida ishlaydi.
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), sharp = require("sharp");
const { Readable } = require("stream"), { pipeline } = require("stream/promises");
sharp.cache(false); sharp.concurrency(1);

module.exports = function ({ app, M, P, bz, notifyChapter }) {
  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) return console.log("BOT_TOKEN yo'q: Telegram bot o'chirilgan");
  const ADMINS = new Set((process.env.TG_ADMINS || "").split(",").map(s => s.trim()).filter(Boolean));
  const SITE = (process.env.SITE_URL || "").replace(/\/+$/, "");
  const SECRET = crypto.createHash("sha256").update("tg" + TOKEN).digest("hex").slice(0, 32);
  const API = "https://api.telegram.org/bot" + TOKEN, MAXW = 1080, CUT = 1800, LIMIT = 20 * 1024 * 1024;
  const SS = new Map();

  const tg = async (m, b) => {
    const r = await fetch(API + "/" + m, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw Error(j.description || "Telegram xatosi");
    return j.result;
  };
  const say = (id, text, kb) => tg("sendMessage", { chat_id: id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) }).catch(e => console.error("sendMessage:", e.message));
  const edit = (id, mid, text) => tg("editMessageText", { chat_id: id, message_id: mid, text, parse_mode: "HTML" }).catch(() => {});
  const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const slug = t => String(t).toLowerCase().replace(/[ʻ'’‘`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const SAVEKB = [[{ text: "Saqlash ✓", callback_data: "save" }, { text: "Bekor ✕", callback_data: "cancel" }]];

  const fresh = () => ({ step: "link", files: [], errs: [], q: Promise.resolve(), pending: 0, busy: false, dir: null, mg: null, num: null, t: null });
  const sess = id => { let s = SS.get(id); if (!s) SS.set(id, s = fresh()); return s; };
  const wipe = s => { clearTimeout(s.t); if (s.dir) fs.rm(s.dir, { recursive: true, force: true }, () => {}); };
  const reset = id => { const s = SS.get(id); if (s) wipe(s); SS.delete(id); };

  // ---- havoladan manga topish: .../manhwa/nom/4, animanxwa://manhwa/nom, ?t=manhwa&s=nom ----
  async function findManga(text) {
    let type, s, m = text.match(/(manga|manhwa|manhua|novella)\/([^\/\s?#]+)/i);
    if (m) { type = m[1].toLowerCase(); s = m[2]; }
    else { const a = text.match(/[?&]t=(manga|manhwa|manhua|novella)/i), b = text.match(/[?&]s=([^&\s#]+)/); if (a && b) { type = a[1].toLowerCase(); s = b[1]; } }
    if (!s) return null;
    try { s = decodeURIComponent(s).toLowerCase(); } catch (e) { s = s.toLowerCase(); }
    const all = await M.find({}).toArray();
    return all.find(x => x.type.toLowerCase() == type && slug(x.title) == s) || all.find(x => slug(x.title) == s) || all.find(x => String(x._id) == s) || null;
  }
  const info = mg => {
    const ns = (mg.chapters || []).map(c => c.num).sort((a, b) => a - b), next = ns.length ? Math.floor(ns[ns.length - 1]) + 1 : 1;
    return { next, text: `${esc(mg.type)} topildi: <b>${esc(mg.title)}</b> ✓\nMavjud boblar: ${ns.length ? ns.join(", ") : "yo'q"}\n\nYangi bob raqamini kiriting (masalan: ${next}):` };
  };

  // ---- rasmni tayyorlash: 1080 px gacha kichraytirish, ~1800 px li bo'laklarga kesish, WebP ----
  async function cutAt(base, tw, y, e) {
    const hb = Math.min(240, e - y - 500); if (hb <= 0) return e;
    const { data, info: n } = await base().extract({ left: 0, top: e - hb, width: tw, height: hb }).flatten({ background: "#ffffff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    for (let r = hb - 1; r >= 0; r--) {
      let lo = 255, hi = 0;
      for (let i = 0; i < tw; i += 6) { const v = data[(r * tw + i) * n.channels]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo < 6) return e - hb + r + 1; // bo'sh (bir xil rangli) qatorda kesamiz
    }
    return e;
  }
  async function slices(src, cut) {
    const meta = await sharp(src, { failOn: "none" }).metadata(), sw = meta.orientation >= 5 ? meta.height : meta.width, sh = meta.orientation >= 5 ? meta.width : meta.height;
    if (!sw || !sh) throw Error("rasm emas");
    const tw = Math.min(sw, MAXW), th = Math.round(sh * tw / sw);
    const base = () => sharp(src, { failOn: "none" }).rotate().resize({ width: tw, height: th, fit: "fill" });
    const out = []; let y = 0;
    while (y < th) {
      let e = Math.min(th, y + (cut ? CUT : 15000)); if (e < th) e = await cutAt(base, tw, y, e);
      const h = e - y; let b;
      for (const q of [82, 70, 55]) { b = await base().extract({ left: 0, top: y, width: tw, height: h }).webp({ quality: q, effort: 3 }).toBuffer(); if (b.length < 7e5) break; }
      out.push({ buf: b, w: tw, h }); y = e;
    }
    return out;
  }
  async function dl(fid) {
    const f = await tg("getFile", { file_id: fid }), r = await fetch("https://api.telegram.org/file/bot" + TOKEN + "/" + f.file_path);
    if (!r.ok) throw Error("faylni yuklab bo'lmadi");
    return Buffer.from(await r.arrayBuffer());
  }
  const DRIVE = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^\s]*?id=)([\w-]{20,})/gi;
  async function driveGet(did, dest) { // Google Drive (Havolasi bor har kim) dan yuklab olish, 20 MB cheklovi yo'q
    let url = `https://drive.usercontent.google.com/download?id=${did}&export=download&confirm=t`;
    for (let t = 0; t < 3; t++) {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) throw Error("Drive xatosi " + r.status);
      if (!/text\/html/i.test(r.headers.get("content-type") || "")) return pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
      const h = await r.text(), f = [...h.matchAll(/name="(id|export|confirm|uuid|authuser)" value="([^"]*)"/g)];
      if (!f.length) throw Error("Drive fayl ochiq emas yoki limit tugagan: «Havolasi bor har kim» ruxsatini bering");
      url = "https://drive.usercontent.google.com/download?" + f.map(m => m[1] + "=" + encodeURIComponent(m[2])).join("&");
    }
    throw Error("Drive'dan yuklab bo'lmadi");
  }
  function estScale(file) { // PDF sahifa o'lchamiga qarab render masshtabi (juda uzun sahifalar uchun ham)
    const fd = fs.openSync(file, "r"), b = Buffer.alloc(4 << 20); let w = 0, h = 0, pos = 0, tail = "";
    try {
      for (;;) {
        const n = fs.readSync(fd, b, 0, b.length, pos); if (!n) break; pos += n;
        const t = tail + b.toString("latin1", 0, n);
        for (const m of t.matchAll(/\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/g)) { w = Math.max(w, m[3] - m[1]); h = Math.max(h, m[4] - m[2]); }
        tail = t.slice(-200);
      }
    } finally { fs.closeSync(fd); }
    if (!(w > 0 && h > 0)) return 1.5;
    return Math.max(0.2, Math.min(MAXW / w, 3, Math.sqrt(14e6 / (w * h)), 30000 / h));
  }
  async function prep(s, f) {
    s.dir = s.dir || fs.mkdtempSync(path.join(os.tmpdir(), "ax-"));
    const cut = s.mg.type != "Manga"; f.out = []; // Manga turida sahifalar kesilmaydi
    const add = async png => { for (const x of await slices(png, cut)) { const p = path.join(s.dir, `${f.mid}-${f.out.length}.webp`); fs.writeFileSync(p, x.buf); f.out.push({ p, w: x.w, h: x.h, size: x.buf.length }); } };
    const file = path.join(s.dir, f.mid + ".src");
    if (f.kind == "drive") await driveGet(f.did, file); else fs.writeFileSync(file, await dl(f.fid));
    const fd = fs.openSync(file, "r"), hd = Buffer.alloc(5); fs.readSync(fd, hd, 0, 5, 0); fs.closeSync(fd);
    if (hd.toString("latin1") != "%PDF-") {
      if (hd[0] == 0x50 && hd[1] == 0x4b) throw Error("ZIP qo'llab-quvvatlanmaydi");
      await add(fs.readFileSync(file)); return fs.rmSync(file, { force: true });
    }
    const pf = file + ".pdf"; fs.renameSync(file, pf);
    const { pdf } = await import("pdf-to-img"); let sc = estScale(pf);
    for (let t = 0; ; t++) {
      const doc = await pdf(pf, { scale: sc });
      try { for await (const png of doc) await add(png); break; }
      catch (e) { if (t >= 4 || !/too big|invalid value|size/i.test(e.message)) throw e; f.out = []; sc = Math.max(0.2, sc * 0.7); }
      finally { if (doc.destroy) await doc.destroy(); }
    }
    fs.rmSync(pf, { force: true });
  }
  // ---- fayl qabul qilish (yuborilgan tartibda ketma-ket tayyorlanadi) ----
  async function onFile(id, s, m) {
    if (s.step != "files") return say(id, s.step == "num" ? "Avval bob raqamini kiriting." : "Avval havola kiriting.");
    let fid, name, size, kind;
    if (m.photo) { const p = m.photo[m.photo.length - 1]; fid = p.file_id; size = p.file_size || 0; name = "foto"; kind = "img"; }
    else { const d = m.document, mt = d.mime_type || ""; fid = d.file_id; size = d.file_size || 0; name = d.file_name || "fayl"; kind = /pdf/i.test(mt) || /\.pdf$/i.test(name) ? "pdf" : /^image\//.test(mt) || /\.(jpe?g|png|webp)$/i.test(name) ? "img" : ""; }
    if (!kind) return say(id, "Bu fayl turi qo'llab-quvvatlanmaydi. PDF, JPG, PNG yoki WEBP yuboring.");
    if (size > LIMIT) return say(id, `«${esc(name)}» 20 MB dan katta. Telegram botlarga bundan katta faylni yuklab olishga ruxsat bermaydi. Faylni Google Drive'ga yuklab havolasini yuboring yoki bo'lib yuboring.`);
    enqueue(id, s, { mid: m.message_id, fid, name, kind, out: null });
  }
  function enqueue(id, s, f) {
    s.files.push(f); s.pending++; clearTimeout(s.t);
    s.q = s.q.then(() => prep(s, f)).catch(e => { console.error("prep:", e); f.out = null; s.errs.push(`${f.name}: ${e.message}`); s.files = s.files.filter(x => x !== f); })
      .then(() => { s.pending--; if (!s.pending) s.t = setTimeout(() => status(id, s), 2000); });
  }
  function status(id, s) {
    if (SS.get(id) !== s || s.pending || s.busy) return;
    const ok = s.files.filter(f => f.out), n = ok.reduce((a, f) => a + f.out.length, 0), mb = (ok.reduce((a, f) => a + f.out.reduce((b, x) => b + x.size, 0), 0) / 1048576).toFixed(1);
    const errs = s.errs.splice(0), head = ok.length ? `Tayyor ✓ ${ok.length} fayl → ${n} bo'lak (${mb} MB)` : "Tayyor fayl yo'q";
    say(id, head + (errs.length ? `\n⚠️ Xato: ${errs.map(esc).join("; ")}` : "") + (ok.length ? "\nYana fayl yuborishingiz yoki saqlashingiz mumkin." : "\nFaylni qayta yuboring yoki Google Drive havolasini tashlang."), ok.length ? SAVEKB : [[{ text: "Bekor ✕", callback_data: "cancel" }]]);
  }

  // ---- Cloudinary ga yuklash va bazaga yozish ----
  async function up(buf, bases) {
    let err;
    for (const z of bases) {
      try {
        const fd = new FormData(); fd.append("file", new Blob([buf], { type: "image/webp" }), "p.webp"); fd.append("upload_preset", z.preset);
        const j = await (await fetch(`https://api.cloudinary.com/v1_1/${z.cloud}/image/upload`, { method: "POST", body: fd })).json();
        if (j.secure_url) return j.secure_url; err = j.error && j.error.message;
      } catch (e) { err = e.message; }
    }
    throw Error(err || "Baza qo'shilmagan");
  }
  async function save(id, s) {
    const all = s.files.filter(f => f.out).sort((a, b) => a.mid - b.mid).flatMap(f => f.out);
    if (!all.length) return say(id, "Saqlash uchun tayyor fayl yo'q. Fayl yuboring.");
    s.busy = true;
    const note = await say(id, `Yuklanmoqda: 0/${all.length}`);
    try {
      const cur = await M.findOne({ _id: s.mg._id });
      if (!cur) throw Error("Manga topilmadi");
      if ((cur.chapters || []).some(c => c.num == s.num)) throw Error(`${s.num}-bob allaqachon mavjud`);
      const bases = await bz(); if (!bases.length) throw Error("Baza yo'q: ilovada Admin paneli > Baza ga Cloudinary qo'shing");
      const urls = []; let k = 0, done = 0, fail = null, last = 0;
      const worker = async () => {
        while (k < all.length && !fail) {
          const i = k++;
          try {
            const buf = fs.readFileSync(all[i].p); let u, er;
            for (let t = 0; t < 3 && !u; t++) { try { u = await up(buf, bases); } catch (e) { er = e; } }
            if (!u) throw er;
            urls[i] = u; done++;
            if (note && Date.now() - last > 3000) { last = Date.now(); edit(id, note.message_id, `Yuklanmoqda: ${done}/${all.length}`); }
          } catch (e) { fail = e; }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (fail) throw fail;
      const cid = Date.now();
      await P.insertOne({ _id: cid, mid: s.mg._id, pages: all.map((x, i) => ({ u: urls[i], w: x.w, h: x.h })) });
      await M.updateOne({ _id: s.mg._id }, { $push: { chapters: { id: cid, num: s.num, vol: 0, season: 0, title: "", at: cid } } });
      if (notifyChapter) notifyChapter(s.mg, { num: s.num });
      const link = (SITE ? SITE + "/" : "animanxwa://") + `${s.mg.type.toLowerCase()}/${slug(s.mg.title) || s.mg._id}/${s.num}`;
      await say(id, `${esc(s.mg.title)} ga\n<b>${s.num}-bob yuklandi ✓</b>\nHavola: ${link}`);
      reset(id);
    } catch (e) { s.busy = false; say(id, "Xato: " + esc(e.message) + "\nQayta urinish uchun «Saqlash ✓» ni bosing.", SAVEKB); }
  }

  // ---- xabarlar ----
  function setNum(id, s, t) {
    if (!s.mg) return say(id, "Avval havola kiriting.");
    const n = parseFloat(String(t).replace(",", "."));
    if (!isFinite(n) || n < 0) return say(id, "Raqam kiriting (masalan: 4).");
    if ((s.mg.chapters || []).some(c => c.num == n)) return say(id, `${n}-bob allaqachon mavjud. Boshqa raqam kiriting.`);
    s.num = n; s.step = "files";
    return say(id, `<b>${esc(s.mg.title)}</b> — <b>${n}-bob</b>\nEndi PDF yoki rasmlarni yuboring (bir nechta fayl mumkin, yuborilgan tartibda qo'shiladi).\nSifat saqlansin desangiz rasmlarni «Fayl» (document) sifatida yuboring. Telegram orqali bittasi 20 MB gacha; kattasi bo'lsa Google Drive havolasini yuboring («Havolasi bor har kim» ruxsati bilan).`);
  }
  async function handle(u) {
    if (u.callback_query) {
      const q = u.callback_query; tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
      const id = q.message && q.message.chat.id; if (!id || !ADMINS.has(String(q.from.id))) return;
      const s = SS.get(id), d = q.data || ""; if (!s) return say(id, "Havola kiriting."); if (s.busy) return;
      if (d == "cancel") { reset(id); return say(id, "Bekor qilindi. Havola kiriting."); }
      if (d == "save") return s.pending ? say(id, "Hali tayyorlanmoqda, kuting...") : save(id, s);
      if (d.startsWith("num:")) return setNum(id, s, d.slice(4));
      return;
    }
    const m = u.message;
    if (!m || m.chat.type !== "private" || !m.from || !ADMINS.has(String(m.from.id))) return; // oddiy foydalanuvchiga javob yo'q
    const id = m.chat.id, text = (m.text || "").trim(), s = sess(id);
    if (s.busy) return say(id, "Jarayon ketmoqda, tugashini kuting...");
    if (/^\/start/i.test(text)) { reset(id); return say(id, "Salom admin - havola kiriting"); }
    if (/^\/cancel/i.test(text)) { reset(id); return say(id, "Bekor qilindi. Havola kiriting."); }
    if (m.document || m.photo) return onFile(id, s, m);
    if (!text) return;
    const dids = [...text.matchAll(DRIVE)].map(x => x[1]);
    if (dids.length) {
      if (s.step != "files") return say(id, s.step == "num" ? "Avval bob raqamini kiriting." : "Avval havola kiriting.");
      return dids.forEach((d, i) => enqueue(id, s, { mid: m.message_id + i / 100, did: d, name: "Drive fayl", kind: "drive", out: null }));
    }
    const mg = await findManga(text);
    if (mg) { wipe(s); SS.set(id, Object.assign(fresh(), { mg, step: "num" })); const f = info(mg); return say(id, f.text, [[{ text: "➕ " + f.next, callback_data: "num:" + f.next }]]); }
    if (/(manga|manhwa|manhua|novella)\/|[?&]s=/i.test(text)) return say(id, "Manga topilmadi. Havolani tekshiring.");
    if (/^\d+([.,]\d+)?$/.test(text)) return setNum(id, s, text);
    return say(id, s.step == "link" ? "Havola kiriting." : s.step == "num" ? "Bob raqamini kiriting." : "PDF yoki rasm yuboring.");
  }

  app.post("/tg/" + SECRET, (q, r) => {
    if (q.headers["x-telegram-bot-api-secret-token"] !== SECRET) return r.sendStatus(403);
    r.sendStatus(200);
    handle(q.body || {}).catch(e => console.error("bot:", e));
  });
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) console.error("RENDER_EXTERNAL_URL topilmadi: Render env ga PUBLIC_URL (server manzili) yozing");
  else tg("setWebhook", { url: base.replace(/\/+$/, "") + "/tg/" + SECRET, secret_token: SECRET, allowed_updates: ["message", "callback_query"] })
    .then(() => console.log("Telegram webhook o'rnatildi, adminlar:", ADMINS.size)).catch(e => console.error("setWebhook xato:", e.message));
};
