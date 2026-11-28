#!/usr/bin/env node
// Güçlü Analiz · Spor Toto otomatik güncelleme betiği
// Harici paket YOK: yalnız Node 18+ yerleşik fetch, crypto, fs, path.
// Ortam değişkenleri:
//   TOTO_SOURCE_URL     (isteğe bağlı) Spor Toto programının çekileceği adres(ler) (boşluk/satır ile ayrılmış; sırayla denenir).
//                       Boşsa varsayılan olarak https://iddaa.com ve https://www.iddaa.com/spor-toto denenir.
//   TOTO_SOURCE_HEADERS (isteğe bağlı) JSON: {"Referer":"https://..."}
//   TOTO_SOURCE_FILE    (isteğe bağlı, test) adres yerine yerel dosyayı okur
//   TOTO_PICK           (isteğe bağlı) kaynakta birden çok 15'lik program varsa "first" (varsayılan) ya da "last"
// Güvence: tam 15 geçerli maç yoksa spor-toto-guncel.json'a DOKUNULMAZ ve süreç hata kodu vermeden biter.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const OUT = path.join(__dirname, "..", "spor-toto-guncel.json");
const DEFAULT_URLS = ["https://iddaa.com", "https://www.iddaa.com/spor-toto"];
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const log = (m) => console.log(m);
const warn = (m) => console.log("::warning::" + m);
const done = (m, w) => { (w ? warn : log)(m); process.exit(0); };

// ---------- yardımcılar ----------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const low = (o) => { const r = {}; for (const k of Object.keys(o)) r[k.toLowerCase()] = o[k]; return r; };
const num = (v) => { if (v == null || typeof v === "boolean") return null; const n = parseFloat(String(v).replace("%", "").replace(",", ".").trim()); return isFinite(n) ? n : null; };
const str = (v) => { if (v == null) return ""; if (typeof v === "object") return str(v.name || v.teamname || v.title || v.ad || ""); return String(v).replace(/\s+/g, " ").trim(); };
const first = (o, keys) => { for (const k of keys) { if (o[k] != null && o[k] !== "") return o[k]; } return null; };
const pad = (n) => String(n).padStart(2, "0");
function normDate(v) {
  const s = str(v); let m;
  if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/))) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}
function normTime(v) { const m = str(v).match(/(\d{1,2}):(\d{2})/); return m ? `${pad(m[1])}:${m[2]}` : null; }
function splitName(s) {
  s = str(s); if (!s) return null;
  let p = s.split(/\s+[-–—]\s+/); if (p.length === 2) return p;
  const idx = []; for (let i = 0; i < s.length; i++) if (s[i] === "-" || s[i] === "–") idx.push(i);
  if (!idx.length) return null;
  const mid = s.length / 2, best = idx.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  return [s.slice(0, best), s.slice(best + 1)];
}
function okPct(a) { return a && a.every((v) => v != null && v >= 0 && v <= 100) && a[0] + a[1] + a[2] >= 90 && a[0] + a[1] + a[2] <= 110; }

// ---------- JSON'dan satır okuma (alan adları tahmine açık) ----------
const EV = ["ev", "evsahibi", "home", "hometeam", "hometeamname", "homename", "h", "t1", "team1", "takim1"];
const DEP = ["dep", "deplasman", "away", "awayteam", "awayteamname", "awayname", "a", "t2", "team2", "takim2"];
const ONE = ["name", "mac", "match", "karsilasma", "karsilasmalar", "title", "eventname", "n"];
const ODD3 = [["ms1", "msx", "ms2"], ["o1", "ox", "o2"], ["odd1", "oddx", "odd2"], ["oran1", "oranx", "oran2"], ["odds1", "oddsx", "odds2"], ["1", "x", "2"]];
const ODDA = ["odds", "oranlar", "ms", "msodds", "oran"];
const PCT3 = [["oyn1", "oynx", "oyn2"], ["p1", "px", "p2"], ["p1", "p0", "p2"], ["pct1", "pctx", "pct2"], ["yuzde1", "yuzdex", "yuzde2"], ["percent1", "percentx", "percent2"], ["y1", "y0", "y2"], ["oynanma1", "oynanma0", "oynanma2"], ["playpercent1", "playpercentx", "playpercent2"]];
const PCTA = ["oynanmayuzdesi", "oynanma", "yuzdeler", "yuzde", "percentages", "percents", "percent", "pct", "play", "playpercent", "playpercentage", "oyn"];
function triple(o, sets, arrs) {
  for (const s of sets) { const a = s.map((k) => num(o[k])); if (a.every((v) => v != null)) return a; }
  for (const k of arrs) {
    const v = o[k]; if (v == null) continue;
    if (Array.isArray(v) && v.length >= 3) { const a = v.slice(0, 3).map(num); if (a.every((x) => x != null)) return a; }
    if (typeof v === "object" && !Array.isArray(v)) { const L = low(v); for (const s of [["1", "x", "2"], ["1", "0", "2"]]) { const a = s.map((q) => num(L[q])); if (a.every((x) => x != null)) return a; } }
  }
  return null;
}
function mapRow(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const L = low(o); let ev = str(first(L, EV)), dep = str(first(L, DEP));
  if (!ev || !dep) { const one = splitName(first(L, ONE)); if (one) { ev = str(one[0]); dep = str(one[1]); } }
  if (ev.length < 2 || dep.length < 2 || ev === dep) return null;
  let odds = triple(L, ODD3, ODDA); if (odds && !odds.every((v) => v > 1)) odds = null;
  let pct = triple(L, PCT3, PCTA); if (!okPct(pct)) pct = null;
  return { ev, dep, tarih: normDate(first(L, ["tarih", "date", "matchdate", "mactarihi", "startdate", "kickoff"])), saat: normTime(first(L, ["saat", "time", "matchtime", "kickoff", "tarih", "date", "matchdate", "startdate"])), odds, pct };
}
function candidates(root) {
  const out = [], seen = new Set();
  (function walk(v, d) {
    if (!v || typeof v !== "object" || d > 9 || seen.has(v)) return; seen.add(v);
    if (Array.isArray(v)) { if (v.length === 15 && v.every((x) => x && typeof x === "object")) { const rows = v.map(mapRow); if (rows.every(Boolean)) out.push(rows); } v.forEach((x) => walk(x, d + 1)); }
    else Object.keys(v).forEach((k) => walk(v[k], d + 1));
  })(root, 0);
  return out;
}
// ---------- metinden / HTML'den satır okuma ("... Takım-Takım %44 %31 %25") ----------
function fromText(text) {
  const t = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<\/(tr|p|div|li)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(td|th)>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  const rows = [];
  for (const line of t.split(/\n+/)) {
    const m = line.match(/^(.*?)%\s*(\d{1,3})[\s|]*%\s*(\d{1,3})[\s|]*%\s*(\d{1,3})/); if (!m) continue;
    let head = m[1], tarih = normDate(head), saat = normTime(head);
    head = head.replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}\s*[-–—]?\s*\d{1,2}:\d{2}/g, " ").replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ")
      .replace(/\|/g, " ").replace(/^\s*\d{1,2}\s*[.)]\s+/, "").replace(/^\s*\d{1,2}\s+(?=\D)/, "").replace(/[\s\-–—]+$/, "").replace(/\s+/g, " ").trim();
    const nm = splitName(head); if (!nm) continue;
    const ev = str(nm[0]), dep = str(nm[1]); if (ev.length < 2 || dep.length < 2) continue;
    const pct = [+m[2], +m[3], +m[4]];
    rows.push({ ev, dep, tarih, saat, odds: null, pct: okPct(pct) ? pct : null });
  }
  return rows.length === 15 ? [rows] : [];
}
function parseBody(body, type) {
  const s = body.trim();
  if (/json/i.test(type || "") || s[0] === "{" || s[0] === "[") { try { return candidates(JSON.parse(s)); } catch (e) { /* metin olarak dene */ } }
  const nd = s.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nd) { try { const c = candidates(JSON.parse(nd[1])); if (c.length) return c; } catch (e) { /* devam */ } }
  return fromText(s);
}
// ---------- ana akış ----------
async function getBodies() {
  if (process.env.TOTO_SOURCE_FILE) return [{ body: fs.readFileSync(process.env.TOTO_SOURCE_FILE, "utf8"), type: "", src: "dosya" }];
  let urls = (process.env.TOTO_SOURCE_URL || "").split(/\s+/).filter(Boolean);
  if (!urls.length) urls = DEFAULT_URLS;
  let extra = {}; try { extra = JSON.parse(process.env.TOTO_SOURCE_HEADERS || "{}"); } catch (e) { /* yok say */ }
  const res = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: Object.assign({ "User-Agent": CHROME_UA, "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "tr-TR,tr;q=0.9" }, extra), signal: AbortSignal.timeout(25000) });
      if (!r.ok) { warn(`Kaynak ${r.status} döndü: ${new URL(u).host}`); continue; }
      res.push({ body: await r.text(), type: r.headers.get("content-type") || "", src: new URL(u).host });
    } catch (e) { warn(`Kaynak okunamadı (${(() => { try { return new URL(u).host; } catch (x) { return "?"; } })()}): ${e.message}`); }
  }
  return res;
}
(async () => {
  const bodies = await getBodies();
  let rows = null, src = "";
  for (const b of bodies) {
    const c = parseBody(b.body, b.type);
    if (c.length) { rows = process.env.TOTO_PICK === "last" ? c[c.length - 1] : c[0]; src = b.src; break; }
  }
  if (!rows) done("Kaynakta tam 15 geçerli maç bulunamadı; spor-toto-guncel.json'a dokunulmadı.", true);
  const maclar = rows.map((r, i) => ({
    no: i + 1, ev: r.ev, dep: r.dep, tarih: r.tarih, saat: r.saat,
    o1: r.odds ? r.odds[0] : null, ox: r.odds ? r.odds[1] : null, o2: r.odds ? r.odds[2] : null,
    oyn: r.pct ? { "1": r.pct[0], x: r.pct[1], "2": r.pct[2] } : null,
  }));
  // Değişiklik özeti: maç listesi + oynanma yüzdeleri (oranlar dalgalandığı için özete katılmaz)
  const programHash = sha(JSON.stringify(maclar.map((m) => [m.ev, m.dep])));
  const hash = sha(JSON.stringify(maclar.map((m) => [m.no, m.ev, m.dep, m.oyn ? [m.oyn["1"], m.oyn.x, m.oyn["2"]] : null])));
  let old = null; try { old = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) { /* ilk kurulum */ }
  if (old && old.hash === hash) done("Değişiklik yok (özet aynı); dosya yazılmadı.");
  const bas = maclar.map((m) => m.tarih).filter(Boolean).sort();
  const json = { version: 1, guncelleme: new Date().toISOString(), kaynak: src, programHash, hash, bas: bas[0] || null, bit: bas[bas.length - 1] || null, maclar };
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(json, null, 2) + "\n"); fs.renameSync(OUT + ".tmp", OUT);
  done(old && old.programHash === programHash ? "Oynanma yüzdeleri değişti; dosya güncellendi." : "Yeni Spor Toto bülteni bulundu; dosya güncellendi.");
})().catch((e) => done("Beklenmeyen hata, dosyaya dokunulmadı: " + (e && e.message), true));
