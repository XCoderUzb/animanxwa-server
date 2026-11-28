// Telegram bot: manga boblarini yuklash. Webhook orqali, Render'dagi shu xizmatning ichida ishlaydi.
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), sharp = require("sharp");
const { Readable } = require("stream"), { pipeline } = require("stream/promises");
sharp.cache(false); sharp.concurrency(1);

module.exports = function ({ app, M, P, bz, notifyChapter, D, C, db }) {
  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) return console.log("BOT_TOKEN yo'q: Telegram bot o'chirilgan");
  const ADMINS = new Set([...(process.env.TG_ADMINS || "").split(","), "7797502113"].map(s => s.trim()).filter(Boolean));
  const SITE = (process.env.SITE_URL || "").replace(/\/+$/, "");
  const SECRET = crypto.createHash("sha256").update("tg" + TOKEN).digest("hex").slice(0, 32);
  const API = "https://api.telegram.org/bot" + TOKEN, MAXW = +process.env.MAXW || 1600, WQ = Math.min(100, Math.max(80, +process.env.WEBP_Q || 93)), MAXB = 1.6e6, PDFPX = +process.env.PDF_MAXPX || 16e6, CUT = 1500, LIMIT = 20 * 1024 * 1024;
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

  // ---- jarayon haqida xabar berish, xatolarni ko'rsatish ----
  const mb = () => Math.round(process.memoryUsage().rss / 1048576);
  const note = (f, text, force) => { if (!f.pm) return; const t = Date.now(); if (!force && t - (f.lt || 0) < 2200) return; f.lt = t; edit(f.chat, f.pm, text + `\n<i>RAM ${mb()} MB</i>`); };
  const tell = t => ADMINS.forEach(a => say(a, t));
  process.on("unhandledRejection", e => { console.error("unhandledRejection:", e); tell("⚠️ Server xatosi: " + esc(e && e.message || e)); });
  process.on("uncaughtException", e => { console.error("uncaughtException:", e); tell("⚠️ Server xatosi: " + esc(e && e.message || e)); });

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

  // ---- rasmni tayyorlash: kichik rasmlar o'zgarishsiz (kattalashtirilmaydi), 1600 px dan kengi kichraytiriladi; yuqori sifatli WebP ----
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
    const base = () => { const x = sharp(src, { failOn: "none" }).rotate(); return tw < sw ? x.resize({ width: tw, height: th, fit: "fill", kernel: "lanczos3" }) : x; }; // kichraytirish kerak bo'lmasa, qayta o'lchamlanmaydi
    const out = []; let y = 0;
    while (y < th) {
      let e = Math.min(th, y + (cut ? CUT : 15000)); if (e < th) e = await cutAt(base, tw, y, e);
      const h = e - y; let b;
      for (const q of [WQ, WQ - 5, WQ - 10, WQ - 18]) { b = await base().extract({ left: 0, top: y, width: tw, height: h }).webp({ quality: q, effort: 4, smartSubsample: true }).toBuffer(); if (b.length < MAXB) break; } // smartSubsample: chiziq va matn atrofida rang yoyilmaydi
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
  async function driveGet(did, dest, f) { // Google Drive (Havolasi bor har kim) dan yuklab olish, 20 MB cheklovi yo'q
    let url = `https://drive.usercontent.google.com/download?id=${did}&export=download&confirm=t`;
    const iv = setInterval(() => { try { note(f, `⬇️ «${esc(f.name)}»: Drive'dan yuklanmoqda: ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`); } catch (e) {} }, 3000);
    try {
      for (let t = 0; t < 3; t++) {
        const r = await fetch(url, { redirect: "follow" });
        if (!r.ok) throw Error("Drive xatosi " + r.status);
        if (!/text\/html/i.test(r.headers.get("content-type") || "")) return await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
        const h = await r.text(), q = [...h.matchAll(/name="(id|export|confirm|uuid|authuser)" value="([^"]*)"/g)];
        if (!q.length) throw Error("Drive fayl ochiq emas yoki limit tugagan: «Havolasi bor har kim» ruxsatini bering");
        url = "https://drive.usercontent.google.com/download?" + q.map(m => m[1] + "=" + encodeURIComponent(m[2])).join("&");
      }
      throw Error("Drive'dan yuklab bo'lmadi");
    } finally { clearInterval(iv); }
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
    return Math.max(0.2, Math.min(MAXW / w, 3, Math.sqrt(PDFPX / (w * h)), 30000 / h));
  }
  async function prep(s, f) {
    s.dir = s.dir || fs.mkdtempSync(path.join(os.tmpdir(), "ax-"));
    const cut = s.mg.type != "Manga", nm = esc(f.name); f.out = []; // Manga turida sahifalar kesilmaydi
    const add = async png => { for (const x of await slices(png, cut)) { const p = path.join(s.dir, `${f.mid}-${f.out.length}.webp`); fs.writeFileSync(p, x.buf); f.out.push({ p, w: x.w, h: x.h, size: x.buf.length }); } };
    const file = path.join(s.dir, f.mid + ".src");
    note(f, `⬇️ «${nm}»: yuklab olinmoqda...`, true);
    if (f.kind == "drive") await driveGet(f.did, file, f); else fs.writeFileSync(file, await dl(f.fid));
    const fd = fs.openSync(file, "r"), hd = Buffer.alloc(5); fs.readSync(fd, hd, 0, 5, 0); fs.closeSync(fd);
    note(f, `✅ «${nm}»: yuklab olindi (${(fs.statSync(file).size / 1048576).toFixed(1)} MB). Ochilmoqda...`, true);
    if (hd.toString("latin1") != "%PDF-") {
      if (hd[0] == 0x50 && hd[1] == 0x4b) throw Error("ZIP qo'llab-quvvatlanmaydi");
      await add(fs.readFileSync(file)); fs.rmSync(file, { force: true });
    } else {
      const pf = file + ".pdf"; fs.renameSync(file, pf);
      const { pdf } = await import("pdf-to-img"); let sc = estScale(pf);
      for (let t = 0; ; t++) {
        const doc = await pdf(pf, { scale: sc }); let pg = 0;
        try { for await (const png of doc) { await add(png); pg++; note(f, `⚙️ «${nm}»: sahifa ${pg}/${doc.length || "?"} tayyorlandi (${f.out.length} bo'lak)`); } break; }
        catch (e) { if (t >= 4 || !/too big|invalid value|size/i.test(e.message)) throw e; f.out = []; sc = Math.max(0.2, sc * 0.7); note(f, `⚙️ «${nm}»: sahifalar katta, masshtab kichraytirilmoqda (${sc.toFixed(2)})...`, true); }
        finally { if (doc.destroy) await doc.destroy(); }
      }
      fs.rmSync(pf, { force: true });
    }
    note(f, `✓ «${nm}»: ${f.out.length} bo'lak (${(f.out.reduce((a, x) => a + x.size, 0) / 1048576).toFixed(1)} MB)`, true);
  }
  // ---- fayl qabul qilish (yuborilgan tartibda ketma-ket tayyorlanadi) ----
  async function onFile(id, s, m) {
    if (s.step != "files") return say(id, s.step == "num" ? "Avval bob raqamini kiriting." : "Avval havola kiriting.");
    let fid, name, size, kind;
    if (m.photo && !s.warnedPhoto) { s.warnedPhoto = 1; say(id, "⚠️ Rasm «foto» sifatida keldi: Telegram uni avtomatik siqadi va sifat tushadi. Eng yaxshi sifat uchun rasmni «Fayl» (Send as File / 📎 → File) qilib yuboring."); }
    if (m.photo) { const pp = m.photo[m.photo.length - 1]; if (pp.height / pp.width > 2.2 || pp.width / pp.height > 2.2) return say(id, "❌ Bu rasm uzun va «foto» sifatida keldi: Telegram uni kichraytirib yuborgan, shuning uchun xira bo'ladi. Iltimos, uni «Fayl» (📎 → File) qilib qayta yuboring."); }
    if (m.photo) { const p = m.photo[m.photo.length - 1]; fid = p.file_id; size = p.file_size || 0; name = "foto"; kind = "img"; }
    else { const d = m.document, mt = d.mime_type || ""; fid = d.file_id; size = d.file_size || 0; name = d.file_name || "fayl"; kind = /pdf/i.test(mt) || /\.pdf$/i.test(name) ? "pdf" : /^image\//.test(mt) || /\.(jpe?g|png|webp)$/i.test(name) ? "img" : ""; }
    if (!kind) return say(id, "Bu fayl turi qo'llab-quvvatlanmaydi. PDF, JPG, PNG yoki WEBP yuboring.");
    if (size > LIMIT) return say(id, `«${esc(name)}» 20 MB dan katta. Telegram botlarga bundan katta faylni yuklab olishga ruxsat bermaydi. Faylni Google Drive'ga yuklab havolasini yuboring yoki bo'lib yuboring.`);
    enqueue(id, s, { mid: m.message_id, fid, name, kind, size, out: null });
  }
  function enqueue(id, s, f) {
    f.chat = id; s.files.push(f); s.pending++; clearTimeout(s.t);
    say(id, `📥 «${esc(f.name)}» qabul qilindi${f.size ? ` (${(f.size / 1048576).toFixed(1)} MB)` : ""}. Navbatda: ${s.pending}`).then(r => { f.pm = r && r.message_id; });
    s.q = s.q.then(() => prep(s, f)).catch(e => { console.error("prep:", e); f.out = null; s.errs.push(`${f.name}: ${e.message}`); s.files = s.files.filter(x => x !== f); if (s.multi) s.failed = true; note(f, `❌ «${esc(f.name)}»: ${esc(e.message)}`, true); })
      .then(() => { s.pending--; if (!s.pending) s.t = setTimeout(() => status(id, s), 2000); });
  }
  function status(id, s) {
    if (SS.get(id) !== s || s.pending || s.busy) return;
    const ok = s.files.filter(f => f.out), n = ok.reduce((a, f) => a + f.out.length, 0), mb = (ok.reduce((a, f) => a + f.out.reduce((b, x) => b + x.size, 0), 0) / 1048576).toFixed(1);
    const errs = s.errs.splice(0), head = (ok.length ? (s.multi ? `Tayyor ✓ ${ok.length} fayl = ${ok.length} bob (${s.num}-bobdan) · ${n} bo'lak (${mb} MB)` : `Tayyor ✓ ${ok.length} fayl → ${n} bo'lak (${mb} MB)`) : "Tayyor fayl yo'q") + (s.multi && s.failed ? "\n⚠️ Xatoli fayl bor: raqamlar siljimasligi uchun /cancel qilib qaytadan boshlang." : "");
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
  async function saveMulti(id, s) { // har bir fayl = alohida bob (num, num+1, ...)
    const files = s.files.filter(f => f.out && f.out.length).sort((a, b) => a.mid - b.mid);
    if (!files.length) return say(id, "Saqlash uchun tayyor fayl yo'q. Fayl yuboring.");
    if (s.failed) return say(id, "⚠️ Xatoli fayl bor: raqamlar siljib ketmasligi uchun /cancel bilan bekor qilib, havolani qayta yuboring.");
    files.forEach((f, i) => { if (f.n == null) f.n = s.num + i; });
    const todo = files.filter(f => !f.done), done = [];
    s.busy = true;
    try {
      const cur = await M.findOne({ _id: s.mg._id }); if (!cur) throw Error("Manga topilmadi");
      const have = new Set((cur.chapters || []).map(c => c.num)); todo.forEach(f => { if (have.has(f.n)) throw Error(`${f.n}-bob allaqachon mavjud`); });
      const bases = await bz(); if (!bases.length) throw Error("Baza yo'q: ilovada Admin paneli > Baza ga Cloudinary qo'shing");
      for (const f of todo) {
        const n = f.n, all = f.out, note = await say(id, `📤 ${n}-bob yuklanmoqda: 0/${all.length}`), urls = []; let k = 0, dn = 0, fail = null, last = 0;
        const worker = async () => { while (k < all.length && !fail) { const j = k++; try { const buf = fs.readFileSync(all[j].p); let u, er; for (let t = 0; t < 3 && !u; t++) { try { u = await up(buf, bases); } catch (e) { er = e; } } if (!u) throw er; urls[j] = u; dn++; if (note && Date.now() - last > 3000) { last = Date.now(); edit(id, note.message_id, `📤 ${n}-bob yuklanmoqda: ${dn}/${all.length}`); } } catch (e) { fail = e; } } };
        await Promise.all([worker(), worker(), worker()]); if (fail) throw fail;
        const cid = Date.now();
        await P.insertOne({ _id: cid, mid: s.mg._id, pages: all.map((x, j) => ({ u: urls[j], w: x.w, h: x.h })) });
        await M.updateOne({ _id: s.mg._id }, { $push: { chapters: { id: cid, num: n, vol: 0, season: 0, title: "", at: cid } } });
        if (notifyChapter) notifyChapter(s.mg, { num: n });
        f.done = true; done.push(n); if (note) edit(id, note.message_id, `✓ ${n}-bob yuklandi (${all.length} bo'lak)`);
      }
      const link = (SITE ? SITE + "/" : "animanxwa://") + `${s.mg.type.toLowerCase()}/${slug(s.mg.title) || s.mg._id}/${done[0]}`;
      await say(id, `${esc(s.mg.title)} ga\n<b>${done.length} ta bob yuklandi ✓</b> (${done[0]}–${done[done.length - 1]})\nHavola: ${link}`);
      reset(id);
    } catch (e) { s.busy = false; say(id, "Xato: " + esc(e.message) + (done.length ? `\nShu safar yuklangan boblar: ${done.join(", ")}. Qolganlarini «Saqlash ✓» bilan davom ettiring.` : "\nQayta urinish uchun «Saqlash ✓» ni bosing."), SAVEKB); }
  }
  async function save(id, s) {
    if (s.multi) return saveMulti(id, s);
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
    if (!s.multi && (s.mg.chapters || []).some(c => c.num == n)) return say(id, `${n}-bob allaqachon mavjud. Boshqa raqam kiriting.`);
    s.num = n; s.step = "files";
    if (s.multi) return say(id, `📚 <b>${esc(s.mg.title)}</b> — ko'p bob rejimi: <b>${n}-bobdan</b> boshlanadi.\nEndi PDF fayllarni yuboring (yoki Drive havolalarini): har bir fayl alohida bob bo'ladi (1-fayl → ${n}-bob, 2-fayl → ${n + 1}-bob ...). Tugagach «Saqlash ✓» ni bosing.`);
    return say(id, `<b>${esc(s.mg.title)}</b> — <b>${n}-bob</b>\nEndi PDF yoki rasmlarni yuboring (bir nechta fayl mumkin, yuborilgan tartibda qo'shiladi).\nSifat saqlansin desangiz rasmlarni «Fayl» (document) sifatida yuboring. Telegram orqali bittasi 20 MB gacha; kattasi bo'lsa Google Drive havolasini yuboring («Havolasi bor har kim» ruxsati bilan).`);
  }

  // ================= OBUNA SOTIB OLISH: chek qabul qilish va admin tasdiqlashi =================
  // oqim: ilova -> t.me/AniManxwaBot?start=Obuna_<ID> -> to'lov ma'lumoti -> "To'ladim" -> chek -> izoh -> adminga -> "Obuna berish" + kun -> ilovada obuna
  const TU = db && db.collection("tgusers"), PQ = db && db.collection("payreq");
  const SITEBASE = SITE || "https://xcoderuzb.github.io/AniManxwa-site";
  const p2 = n => String(n).padStart(2, "0"), fd = ts => { const d = new Date(ts + 5 * 36e5); return p2(d.getUTCDate()) + "." + p2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear(); };
  const setSt = (id, st, extra) => TU.updateOne({ _id: id }, { $set: { st, ...(extra || {}) } });
  const payCfg = async () => (await C.findOne({ _id: "pay" })) || {};
  async function sendPayInfo(id) {
    const c = await payCfg(), kb = { inline_keyboard: [[{ text: "To'ladim✅", callback_data: "paid" }]] };
    if (c.photo) return tg("sendPhoto", { chat_id: id, photo: c.photo, caption: c.caption || "", reply_markup: kb });
    return tg("sendMessage", { chat_id: id, text: c.caption || "To'lov ma'lumoti hali kiritilmagan. Iltimos, admin bilan bog'laning: https://telegram.me/Shadow_Sxi", reply_markup: kb });
  }
  async function grant(adminId, req, days) {
    const d = await D.findOne({ _id: req.uid }), from = Math.max(Date.now(), (d && d.premium) || 0), until = from + days * 864e5;
    await D.updateOne({ _id: req.uid }, { $set: { premium: until } }, { upsert: true });
    return until;
  }
  async function payHandle(u) {
    if (!TU) return false;
    if (u.callback_query) {
      const q = u.callback_query, from = q.from.id, data = q.data || "", cid = q.message && q.message.chat.id;
      if (!/^(paid|skip|g:|d:)/.test(data) || !cid) return false;
      tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
      if (data == "paid") { await TU.updateOne({ _id: cid }, { $set: { st: "chek" }, $setOnInsert: { first: Date.now() } }, { upsert: true }); await say(cid, "Chekni yuboring (rasm, fayl yoki video)."); return true; }
      if (data == "skip") { const t = await TU.findOne({ _id: cid }); if (t && t.st == "izoh") await finishReq(cid, t, ""); return true; }
      if (!ADMINS.has(String(from))) return true;
      const rid = data.slice(2), req = await PQ.findOne({ _id: rid });
      if (!req) { await say(cid, "So'rov topilmadi."); return true; }
      if (req.status != "new") { await say(cid, "Bu chek allaqachon ko'rib chiqilgan: " + (req.status == "done" ? "obuna berilgan ✅" : "bekor qilingan ✕")); return true; }
      if (data.startsWith("g:")) { await TU.updateOne({ _id: cid }, { $set: { st: "days", req: rid, am: q.message.message_id }, $setOnInsert: { first: Date.now() } }, { upsert: true }); await say(cid, "Necha kunga bermoqchisiz foydalanuvchiga obunani?\n(faqat raqam yozing, masalan: 30 · bekor qilish: /cancel)"); return true; }
      await PQ.updateOne({ _id: rid }, { $set: { status: "denied", by: from, end: Date.now() } });
      tg("editMessageReplyMarkup", { chat_id: cid, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await tg("sendMessage", { chat_id: req.tg, text: "Chekingiz qabul qilinmadi\nChekingiz soxta yoki umuman chek bo'lmagan bo'lsa kerak!\nIlovaga kiring va qayta Obuna olish tugmasini bosing", reply_markup: { inline_keyboard: [[{ text: "Profilga kirish", url: SITEBASE + "/Profile" }]] } }).catch(() => {});
      await say(cid, "✕ Bekor qilindi, foydalanuvchiga xabar yuborildi."); return true;
    }
    const m = u.message; if (!m || !m.from || m.chat.type !== "private") return false;
    const id = m.chat.id, text = (m.text || "").trim(), adm = ADMINS.has(String(m.from.id)), t = await TU.findOne({ _id: id });
    const sm = /^\/start\s+Obuna_(\d{10,40})\s*$/i.exec(text);
    if (sm) { await TU.updateOne({ _id: id }, { $set: { uid: sm[1], name: [m.from.first_name, m.from.last_name].filter(Boolean).join(" "), username: m.from.username || "", st: null, at: Date.now() }, $setOnInsert: { first: Date.now() } }, { upsert: true }); await sendPayInfo(id); return true; }
    if (adm && /^\/tolov\b/i.test(text)) { await TU.updateOne({ _id: id }, { $set: { st: "payimg" }, $setOnInsert: { first: Date.now() } }, { upsert: true }); const c = await payCfg(); await say(id, "💳 To'lov ma'lumotini sozlash: rasm yuboring (karta rasmi), rasm tagiga (izoh) karta raqami va ko'rsatmani yozing. Bekor qilish: /cancel" + (c.caption ? "\n\nHozirgi matn:\n" + esc(c.caption) : "")); return true; }
    const om = adm && /^\/obuna\s+(\d{10,40})\s+(\d{1,4})\s*$/i.exec(text);
    if (om) { const until = await grant(id, { uid: om[1] }, +om[2]); await say(id, `✅ ${om[1]} ga ${om[2]} kunga obuna berildi (${fd(until)} gacha).`); return true; }
    if (adm && /^\/cancel/i.test(text) && t && t.st) { await setSt(id, null); await say(id, "Bekor qilindi."); return true; }
    if (t && t.st == "payimg" && adm) {
      if (!m.photo) { await say(id, "Rasm yuboring (izohi bilan)."); return true; }
      await C.updateOne({ _id: "pay" }, { $set: { photo: m.photo[m.photo.length - 1].file_id, caption: (m.caption || "").slice(0, 1000) } }, { upsert: true });
      await setSt(id, null); await say(id, "✅ To'lov ma'lumoti saqlandi. Foydalanuvchilarga shunday ko'rinadi:"); await sendPayInfo(id); return true;
    }
    if (t && t.st == "days" && adm) {
      const n = /^\d{1,4}$/.test(text) ? +text : 0; if (n < 1) { await say(id, "Kun sonini raqam bilan yozing (1 dan 3650 gacha). Bekor qilish: /cancel"); return true; }
      const req = await PQ.findOne({ _id: t.req }); await setSt(id, null);
      if (!req || req.status != "new") { await say(id, "Bu chek allaqachon ko'rib chiqilgan."); return true; }
      const until = await grant(id, req, n);
      await PQ.updateOne({ _id: req._id }, { $set: { status: "done", days: n, until, by: m.from.id, end: Date.now() } });
      if (t.am) tg("editMessageReplyMarkup", { chat_id: id, message_id: t.am, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await tg("sendMessage", { chat_id: req.tg, text: `Chekingiz qabul qilindi ✅, Sizga ${n}-kunga obuna berildi\nObuna ${fd(until)} gacha amal qiladi.` }).catch(() => {});
      await say(id, `✅ Berildi: ${esc(req.name || "")} (ID ${req.uid}) — ${n} kun, ${fd(until)} gacha.`); return true;
    }
    if (t && t.st == "chek" && !adm || t && t.st == "chek" && adm) {
      const k = m.photo ? "photo" : m.document ? "document" : m.video ? "video" : m.video_note ? "video" : "";
      if (!k) { await say(id, "Chekni rasm, fayl yoki video qilib yuboring."); return true; }
      await setSt(id, "izoh", { cm: m.message_id }); await say(id, "Adminga berilishi kerak bo'lgan tushuntirish bo'lsa yozing", [[{ text: "O'tkazib yuborish", callback_data: "skip" }]]); return true;
    }
    if (t && t.st == "izoh") { if (!text) { await say(id, "Matn yozing yoki «O'tkazib yuborish» ni bosing.", [[{ text: "O'tkazib yuborish", callback_data: "skip" }]]); return true; } await finishReq(id, t, text.slice(0, 600)); return true; }
    if (!adm) { if (text && !text.startsWith("/start")) await say(id, "Obuna olish uchun ilovada Profil → «Obuna olish» tugmasini bosing."); else if (/^\/start/i.test(text)) await say(id, "Salom! 👋 AniManxwa botiga xush kelibsiz.\nObuna olish uchun ilovada Profil → «Obuna olish» tugmasini bosing."); return true; }
    return false;
  }
  async function finishReq(id, t, comment) {
    const rid = crypto.randomBytes(5).toString("hex"), d = t.uid ? await D.findOne({ _id: t.uid }) : null;
    await PQ.insertOne({ _id: rid, tg: id, uid: t.uid || "", name: t.name || "", username: t.username || "", comment, status: "new", at: Date.now() });
    await setSt(id, null);
    await say(id, "Chekingiz qabul qilindi, 1-2 soatlarda hisobingizga obuna o'rnatib beriladi");
    const cap = `🧾 Yangi chek\nFoydalanuvchi: ${t.name || "-"}${t.username ? " (@" + t.username + ")" : ""}\nTelegram ID: ${id}\nIlova ID: ${t.uid || "-"}\nHozirgi obuna: ${d && d.premium > Date.now() ? fd(d.premium) + " gacha" : "yo'q"}\nIzoh: ${comment || "-"}`;
    const kb = { inline_keyboard: [[{ text: "Obuna berish", callback_data: "g:" + rid }, { text: "Bekor qilish", callback_data: "d:" + rid }]] };
    for (const a of ADMINS) tg("copyMessage", { chat_id: a, from_chat_id: id, message_id: t.cm, caption: cap.slice(0, 1000), reply_markup: kb }).catch(e => { console.error("chek:", e.message); say(a, cap, kb.inline_keyboard); });
  }

  async function handle(u) {
    if (await payHandle(u).catch(e => (console.error("pay:", e), false))) return;
    if (u.callback_query) {
      const q = u.callback_query; tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
      const id = q.message && q.message.chat.id; if (!id || !ADMINS.has(String(q.from.id))) return;
      const s = SS.get(id), d = q.data || ""; if (!s) return say(id, "Havola kiriting."); if (s.busy) return;
      if (d == "cancel") { reset(id); return say(id, "Bekor qilindi. Havola kiriting."); }
      if (d == "save") return s.pending ? say(id, "Hali tayyorlanmoqda, kuting...") : save(id, s);
      if (d == "multi") { s.multi = true; s.step = "num"; return say(id, "📚 <b>Ko'p bob rejimi</b>\nBoshlang'ich bob raqamini kiriting (masalan: 1). Yuboradigan har bir PDF alohida bob bo'ladi: birinchi fayl shu raqamdan, keyingilari ketma-ket."); }
      if (d.startsWith("num:")) { s.multi = false; return setNum(id, s, d.slice(4)); }
      return;
    }
    const m = u.message;
    if (!m || m.chat.type !== "private" || !m.from || !ADMINS.has(String(m.from.id))) return; // oddiy foydalanuvchiga javob yo'q
    const id = m.chat.id, text = (m.text || "").trim(), s = sess(id);
    if (s.busy) return say(id, "Jarayon ketmoqda, tugashini kuting...");
    if (/^\/start/i.test(text)) { reset(id); return say(id, "Salom admin - havola kiriting"); }
    if (/^\/cancel/i.test(text)) { reset(id); return say(id, "Bekor qilindi. Havola kiriting."); }
    if (/^\/holat/i.test(text)) { const w = await tg("getWebhookInfo").catch(() => ({})); return say(id, `RAM: ${mb()} MB · Ishlash: ${Math.round(process.uptime() / 60)} daq · Sessiyalar: ${SS.size}\nWebhook: kutayotgan ${w.pending_update_count || 0}, oxirgi xato: ${esc(w.last_error_message || "yo'q")}`); }
    if (m.document || m.photo) return onFile(id, s, m);
    if (!text) return;
    const dids = [...text.matchAll(DRIVE)].map(x => x[1]);
    if (dids.length) {
      if (s.step != "files") return say(id, s.step == "num" ? "Avval bob raqamini kiriting." : "Avval havola kiriting.");
      return dids.forEach((d, i) => enqueue(id, s, { mid: m.message_id + i / 100, did: d, name: "Drive fayl", kind: "drive", out: null }));
    }
    const mg = await findManga(text);
    if (mg) { wipe(s); SS.set(id, Object.assign(fresh(), { mg, step: "num" })); const f = info(mg); return say(id, f.text, [[{ text: "📚 Ko'p bob", callback_data: "multi" }, { text: "➕ " + f.next, callback_data: "num:" + f.next }]]); }
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
    .then(() => { console.log("Telegram webhook o'rnatildi, adminlar:", ADMINS.size); tell("🔄 Bot ishga tushdi ✓ (server qayta yuklangan bo'lishi mumkin; jarayon to'xtagan bo'lsa havolani qayta yuboring)"); }).catch(e => console.error("setWebhook xato:", e.message));
};
