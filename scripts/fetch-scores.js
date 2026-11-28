#!/usr/bin/env node
// Güçlü Analiz · Canlı skor betiği (API-Football ücretsiz plan, günlük 100 istek)
// Harici paket YOK: yalnız Node 18+ yerleşik fetch, crypto, fs, path.
// KOTA: her çalışmada YALNIZCA 1 istek atılır (bugünün tüm maçları, tek çağrı). Yeniden deneme yoktur.
// KAPSAM: dünyadaki TÜM ligler ve maçlar (lig filtresi yok). Dosya küçük kalsın diye yalnız id, ev, dep, d (durum), dk, es, ds yazılır.
// Ortam değişkenleri:
//   API_FOOTBALL_KEY   (zorunlu) GitHub Secrets'tan
//   API_FOOTBALL_BASE  (isteğe bağlı, test) varsayılan https://v3.football.api-sports.io
//   NS_HEPSI           (isteğe bağlı) "1" ise henüz başlamamış TÜM maçlar da dosyaya yazılır (varsayılan: yalnız Spor Toto maçları)
//   SKOR_DATE          (isteğe bağlı, test) YYYY-MM-DD
// Güvence: hata, kota dolu, anahtar yok, ağ yok ya da geçersiz cevapta canli-skorlar.json'a DOKUNULMAZ ve süreç hata kodu vermeden biter.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "canli-skorlar.json"), TOTO = path.join(ROOT, "spor-toto-guncel.json");
const BASE = (process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io").replace(/\/+$/, "");
const NS_ALL = process.env.NS_HEPSI === "1", NS_SET = new Set(["NS", "TBD"]);
const warn = (m) => console.log("::warning::" + m);
const done = (m, w) => { (w ? warn : console.log)(m); process.exit(0); };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- takım adı eşleştirme (Spor Toto listesi ↔ API adı) ----
const fold = (s) => String(s || "").toLowerCase().replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/i̇/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u").replace(/â/g, "a").replace(/[^a-z0-9 ]+/g, " ");
const STOP = new Set(["as", "a", "s", "fk", "sk", "fc", "kulubu", "spor", "sportif", "faaliyetler", "afc", "cf", "ac", "bb", "belediyesi", "ve", "the", "1", "sv", "fsv", "tsg", "vfl", "vfb"]);
const toks = (s) => fold(s).split(/\s+/).filter((t) => t && !STOP.has(t));
const tokMatch = (a, b) => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b)) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
const RESV = /^(b|ii|iii|u\d\d|reserves?|youth|women|w|kadin|kadinlar)$/;
function teamSim(a, b) {
  const A = toks(a), B = toks(b); if (!A.length || !B.length) return 0;
  if (A.slice(1).some((t) => RESV.test(t)) !== B.slice(1).some((t) => RESV.test(t))) return 0; // yedek/genç/kadın takımı ana takımla eşleşmesin
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  const hit = S.filter((t) => L.some((u) => tokMatch(t, u))).length;
  return hit / Math.max(S.length, 1) * (S.length === 1 && L.length > 3 ? 0.8 : 1);
}
function loadToto() { try { const j = JSON.parse(fs.readFileSync(TOTO, "utf8")); return Array.isArray(j.maclar) ? j.maclar : []; } catch (e) { return []; } }
function totoNoOf(f, toto) {
  let best = 0, no = null;
  for (const t of toto) { const a = teamSim(t.ev, f.teams.home.name), b = teamSim(t.dep, f.teams.away.name); if (a >= 0.8 && b >= 0.8 && a + b > best) { best = a + b; no = t.no; } }
  return no;
}
// ---- ana akış ----
function istDate(offsetMs) { return new Date(Date.now() + offsetMs).toLocaleDateString("sv-SE", { timeZone: "Europe/Istanbul" }); }
(async () => {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) done("API_FOOTBALL_KEY tanımlı değil (Settings > Secrets and variables > Actions > Secrets); istek atılmadı.", true);
  // 00:xx (TSİ) çalışmasında gece yarısını aşan maçlar için önceki günün listesi alınır
  const date = process.env.SKOR_DATE || istDate(-3600e3);
  let res;
  try {
    res = await fetch(`${BASE}/fixtures?date=${date}&timezone=Europe/Istanbul`, { headers: { "x-apisports-key": key, Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  } catch (e) { done("API'ye ulaşılamadı: " + e.message, true); }
  const rem = res.headers.get("x-ratelimit-requests-remaining");
  console.log(`İstek: 1 · tarih ${date} · HTTP ${res.status}${rem != null ? " · bugün kalan hak: " + rem : ""}`);
  if (!res.ok) done("API " + res.status + " döndü; dosyaya dokunulmadı.", true);
  let j; try { j = await res.json(); } catch (e) { done("Cevap JSON değil; dosyaya dokunulmadı.", true); }
  const errs = j && j.errors ? (Array.isArray(j.errors) ? j.errors : Object.values(j.errors)) : [];
  if (errs.length) done("API hata bildirdi: " + errs.map(String).join(" | ").slice(0, 300) + " — dosyaya dokunulmadı.", true);
  if (!j || !Array.isArray(j.response)) done("Beklenmeyen cevap yapısı; dosyaya dokunulmadı.", true);
  const toto = loadToto(), out = []; let nsAtla = 0;
  for (const f of j.response) {
    try {
      if (!f || !f.fixture || !f.teams || !f.goals || !f.fixture.status) continue;
      const d = f.fixture.status.short, ev = f.teams.home && f.teams.home.name, dep = f.teams.away && f.teams.away.name;
      if (!ev || !dep) continue;
      // Başlamamış maçın skoru/dakikası yoktur; dosya şişmesin diye yalnız Spor Toto listesindekiler ("Bekliyor") tutulur. Maç başlayınca kendiliğinden eklenir.
      if (NS_SET.has(d) && !NS_ALL && totoNoOf(f, toto) == null) { nsAtla++; continue; }
      const m = { id: f.fixture.id, ev, dep, d, dk: f.fixture.status.elapsed == null ? null : f.fixture.status.elapsed, es: f.goals.home, ds: f.goals.away };
      const ft = f.score && f.score.fulltime; // 90 dakika skoru yalnız uzatmaya/penaltıya giden maçlarda gerekir
      if ((d === "AET" || d === "PEN") && ft && ft.home != null) { m.e90 = ft.home; m.d90 = ft.away; }
      for (const k of ["dk", "es", "ds"]) if (m[k] == null) delete m[k];
      out.push(m);
    } catch (e) { /* bozuk satırı atla */ }
  }
  out.sort((a, b) => a.id - b.id);
  // Değişiklik özeti: yalnız maç durumu ve skor (dakika özete girmez; sayfa dakikayı kendisi ilerletir)
  const hash = sha(JSON.stringify(out.map((m) => [m.id, m.d, m.es, m.ds, m.e90, m.d90])));
  let old = null; try { old = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) { /* ilk kurulum */ }
  if (old && old.hash === hash && old.tarih === date) done(`Skor/durum değişmedi (${out.length} maç); dosya yazılmadı.`);
  if (!out.length && old && old.maclar && old.maclar.length && old.tarih === date) done("API bu tarih için boş liste verdi; mevcut dosya korundu.", true);
  const json = { version: 1, guncelleme: new Date().toISOString(), tarih: date, hash, maclar: out };
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(json) + "\n"); fs.renameSync(OUT + ".tmp", OUT);
  done(`canli-skorlar.json güncellendi: ${out.length} maç yazıldı (API'den ${j.response.length} maç geldi, ${nsAtla} başlamamış maç dosyaya alınmadı; ${(JSON.stringify(json).length / 1024).toFixed(0)} KB).`);
})().catch((e) => done("Beklenmeyen hata, dosyaya dokunulmadı: " + (e && e.message), true));
