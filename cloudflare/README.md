# Pallas — Cloudflare Workers dağıtımı

Bu klasör, Pallas web uygulamasının Render yerine **Cloudflare Workers** üzerinde
çalışan sürümüdür. `server.js` (masaüstü/Electron uygulaması, yerel Ollama ile
çalışır) buna dokunulmadan aynen kalır — bu tamamen ayrı, bulut tabanlı bir
dağıtımdır.

Canlı adres: **https://app.pallasation.com** (worker adı: `pallas-app`).

> **Önemli — worker adı çakışması:** Bu Cloudflare hesabında zaten `pallas`
> adında, temmuz ayından beri `pallasation.com` / `www.pallasation.com` /
> `using.pallasation.com` adreslerinde canlı duran BAŞKA bir worker vardı
> (asıl ana site). İlk denemede bu worker'ı da `pallas` olarak adlandırıp
> deploy ettiğimizde, Cloudflare'de worker adları hesap başına tekil olduğu
> için o siteyi bilmeden ezmiştik. `wrangler rollback` ile eski site geri
> alındı ve bu proje **`pallas-app`** adıyla ayrı bir worker olarak yeniden
> deploy edildi, `app.pallasation.com` da ona taşındı. Bu yüzden
> `wrangler.toml`'daki `name` değerini **asla** `pallas` yapma — mevcut ana
> siteyi tekrar ezersin.

Farklar (server.js'e göre):
- Kullanıcılar ve sohbetler artık dosyaya değil **Cloudflare D1** (SQL) veritabanına yazılır.
- Kısa süreli sohbet oturumları (`sessions`) artık bellekte değil **Cloudflare KV**'de tutulur (30 dakika TTL).
- Yapay zeka backend'i her zaman **Groq** bulut API'sidir (Cloudflare'den yerel Ollama'ya erişilemez).
- Statik dosyalar (`public/`) doğrudan Worker'ın "assets" özelliğiyle servis edilir.

## Kurulum adımları (sıfırdan kurulacaksa)

```bash
cd cloudflare
npm install

# 1) Cloudflare hesabına giriş (tarayıcı açılacak)
npx wrangler login

# 2) D1 veritabanını oluştur
npx wrangler d1 create pallas
# Çıktıdaki database_id değerini wrangler.toml içine yapıştır.

# 3) Şemayı veritabanına uygula
npm run db:init

# 4) KV namespace oluştur (oturumlar için)
npx wrangler kv namespace create SESSIONS
# Çıktıdaki id değerini wrangler.toml içine yapıştır.

# 5) Gizli anahtarları ayarla
npx wrangler secret put JWT_SECRET
npx wrangler secret put GROQ_API_KEY

# 6) Dağıt
npm run deploy
```

## Domain bağlama

`app.pallasation.com`, Cloudflare panelinden (Workers & Pages → pallas-app →
Settings → Domains & Routes) veya API üzerinden `pallas-app` worker'ına
custom domain olarak bağlandı. Yeni bir domain eklerken **mutlaka önce
mevcut custom domain listesini kontrol et** (`wrangler.toml`'daki worker
adının başka bir yerde kullanılıp kullanılmadığını görmek için), aksi halde
yine bir çakışma yaşanabilir.
