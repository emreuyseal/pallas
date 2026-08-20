# Pallas — Cloudflare Workers dağıtımı

Bu klasör, Pallas web uygulamasının Render yerine **Cloudflare Workers** üzerinde
çalışan sürümüdür. `server.js` (masaüstü/Electron uygulaması, yerel Ollama ile
çalışır) buna dokunulmadan aynen kalır — bu tamamen ayrı, bulut tabanlı bir
dağıtımdır.

Farklar:
- Kullanıcılar ve sohbetler artık dosyaya değil **Cloudflare D1** (SQL) veritabanına yazılır.
- Kısa süreli sohbet oturumları (`sessions`) artık bellekte değil **Cloudflare KV**'de tutulur (30 dakika TTL).
- Yapay zeka backend'i her zaman **Groq** bulut API'sidir (Cloudflare'den yerel Ollama'ya erişilemez).
- Statik dosyalar (`public/`) doğrudan Worker'ın "assets" özelliğiyle servis edilir.

## Kurulum adımları

Bu adımları kendi terminalinde çalıştırman gerekiyor — Cloudflare hesabına giriş
gerektirdiği için benim tarafımdan otomatik yapılamıyor.

```bash
cd cloudflare
npm install

# 1) Cloudflare hesabına giriş (tarayıcı açılacak)
npx wrangler login

# 2) D1 veritabanını oluştur
npx wrangler d1 create pallas
# Çıktıdaki database_id değerini wrangler.toml içindeki
# "REPLACE_AFTER_WRANGLER_D1_CREATE" yerine yapıştır.

# 3) Şemayı veritabanına uygula
npm run db:init

# 4) KV namespace oluştur (oturumlar için)
npx wrangler kv namespace create SESSIONS
# Çıktıdaki id değerini wrangler.toml içindeki
# "REPLACE_AFTER_WRANGLER_KV_CREATE" yerine yapıştır.

# 5) Gizli anahtarları ayarla
npx wrangler secret put JWT_SECRET
# (rastgele, uzun bir metin gir — örn. `openssl rand -hex 32`)
npx wrangler secret put GROQ_API_KEY
# (console.groq.com üzerinden aldığın API anahtarı)

# 6) Dağıt
npm run deploy
```

Deploy tamamlanınca terminalde `https://pallas.<hesap-adın>.workers.dev` gibi bir
adres göreceksin. İstersen Cloudflare panelinden kendi alan adını (custom domain)
bu Worker'a bağlayabilirsin (Workers & Pages → pallas → Settings → Domains & Routes).

## Sonrasında yapılacak

Nihai adresi öğrendikten sonra `docs/index.html` içindeki
`https://pallas-8ma0.onrender.com` linklerini yeni adresle değiştirmemiz
gerekiyor — bana adresi verdiğinde bunu güncellerim. Render'daki servisi de
(render.com panelinden) o noktada silebilirsin.
