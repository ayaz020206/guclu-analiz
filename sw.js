// Güçlü Analiz · Service Worker (uygulama dosyalarını internetsiz açılış için saklar)
// Model dosyaları burada değil, WebLLM'in kendi önbelleğinde (webllm/...) durur; bu dosya onlara dokunmaz.
const V = "ga-v124";
const CORE = ["./", "index.html", "manifest.webmanifest", "webllm.js", "ai-worker.js", "icon-192.png", "icon-512.png"];
const SKIP = /firestore\.googleapis|identitytoolkit|securetoken|googleapis\.com\/(identitytoolkit|v1)|huggingface\.co|hf\.co|raw\.githubusercontent|workers\.dev|anthropic\.com/;
const XCACHE = /gstatic\.com\/firebasejs|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/;
self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("ga-") && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
function fromNet(req, cacheIt) {
  return fetch(req).then(r => { if (cacheIt && (r.ok || r.type === "opaque")) { const cp = r.clone(); caches.open(V).then(c => c.put(req, cp)).catch(() => {}); } return r; });
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = req.url; if (!/^https?:/.test(url) || SKIP.test(url)) return;
  if (req.mode === "navigate") {
    // önce ağ (güncel sürüm gelsin); ağ yoksa ya da 5 sn içinde cevap gelmezse kayıtlı kopya
    e.respondWith(Promise.race([
      fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put("index.html", cp)); } return r; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("zaman aşımı")), 5000))
    ]).catch(() => caches.match("index.html").then(r => r || caches.match("./")).then(r => r || new Response("<h3 style='font-family:sans-serif;padding:20px'>Çevrimdışısın ve bu cihazda uygulamanın kayıtlı kopyası yok. İnternete bağlanınca sayfayı bir kez aç; sonraki açılışlarda internetsiz de açılır.</h3>", { headers: { "content-type": "text/html; charset=utf-8" } }))));
    return;
  }
  const same = new URL(url).origin === self.location.origin;
  if (same) { // kayıtlı kopyayı hemen ver, arkadan yenile
    e.respondWith(caches.match(req).then(c => { const n = fromNet(req, true).catch(() => c); return c || n; }));
    return;
  }
  if (XCACHE.test(url)) { // sürümlü dış kütüphaneler: önce önbellek
    e.respondWith(caches.match(req).then(c => c || fromNet(req, true)));
  }
});
