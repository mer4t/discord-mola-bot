# Discord Mola / Rez Botu

Bu bot; vardiyaya göre **6 farklı kanal** (3 vardiya × 2 kanal: *mola* + *rez*) üzerinden **rezervasyonlu mola** sistemini yönetir.

- Normal mola **rezervasyonla** başlar: `/rez` → zamanı gelince mola kanalında `/mola`
- Acil mola rez gerekmez: `/acil`
- Aynı anda havuz kapasitesi:
  - **10 dk**: max **2 kişi**
  - **20 dk**: max **1 kişi**
- Her vardiya başında haklar sıfırlanır:
  - **10 dk × 2**
  - **20 dk × 1**
- Rez alınabilecek zaman aralığı: **şu andan itibaren max 2 saat sonrası**
- Rez başlangıcından sonra **5 dk içinde** mola başlatılmazsa rez **iptal** olur ve hak geri döner.
- Mola bitince `/devam` yazılmazsa **10 dk sonra auto-close** olur.

> Zaman dilimi: `TZ` ile belirlenir (varsayılan: `Europe/Istanbul`).

---

## 1) Kurulum

### Gerekenler
- Node.js **18+**
- Discord bot token

### Dosyaları indir

```bash
npm install
```

### .env oluştur

`.env.example` dosyasını kopyala:

```bash
cp .env.example .env
```

`.env` içine şu alanları doldur:

| Değişken | Açıklama |
|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal → Bot → Token |
| `CLIENT_ID` | Discord Developer Portal → Application ID |
| `GUILD_ID` | Sunucu ID (Developer Mode → sunucuya sağ tık → Copy ID) |
| `ADMIN_ROLE_ID` | Admin rolünün ID'si (virgülle birden fazla yazılabilir) |
| `MORNING_MOLA_CHANNEL_ID` | Sabah vardiyası mola kanalı |
| `MORNING_REZ_CHANNEL_ID` | Sabah vardiyası rez kanalı |
| `EVENING_MOLA_CHANNEL_ID` | Akşam vardiyası mola kanalı |
| `EVENING_REZ_CHANNEL_ID` | Akşam vardiyası rez kanalı |
| `NIGHT_MOLA_CHANNEL_ID` | Gece vardiyası mola kanalı |
| `NIGHT_REZ_CHANNEL_ID` | Gece vardiyası rez kanalı |
| `ADMIN_BREAK_CHANNEL_IDS` | Admin molalarının duyurulacağı kanal(lar), virgülle ayrılır |

> Kanal ID almak için Discord'da Developer Mode aç → kanala sağ tık → Copy ID.

> İkinci sunucu (Guild 2) için `.env.example` içindeki `G2_*` değişkenlerini doldur. Opsiyoneldir.

---

## 2) Slash Komutları Yükleme

Discord'a komutları eklemek için:

```bash
npm run deploy
```

Komutlar **guild** seviyesine yüklenir (anında görünür).

---

## 3) Botu Çalıştırma

```bash
npm start
```

Sürekli çalışması için PM2 önerilir:

```bash
npm install -g pm2
pm2 start index.js --name mola-bot
pm2 save
```

---

## 4) Nickname Vardiya Formatı

Bot, kullanıcı vardiyasını **nick** üzerinden okur.

Nick içinde şu pattern olmalı:

| Vardiya | Saatler |
|---|---|
| Sabah | `08.00 - 16.00` veya `10.00 - 18.00` |
| Akşam | `16.00 - 00.00` veya `18.00 - 02.00` veya `20.00 - 04.00` |
| Gece | `00.00 - 08.00` |

Örnek nick: `Ahmet | 16.00 - 00.00`

> Nokta yerine `:` da kabul edilir (`16:00 - 00:00`).

---

## 5) Komutlar

### Rez kanalı komutları

#### `/rez sure:10 saat:13:40 bekle:true`
- İstenen saat vardiyanın içindeyse ve kapasite uygunsa rezervasyon oluşturur.
- Kapasite doluysa:
  - Otomatik olarak uygun **alternatif 3 saat** önerir.
  - `bekle:true` verilirse **bekleme listesine** ekler ve slot boşalınca ping atar.

#### `/rezliste`
- Kendi pending rez'lerini ve havuzun o anki durumunu gösterir.

#### `/reziptal`
- Parametresiz: en yakın pending rezi iptal eder.
- `saat:HH:MM`: o saatli rezi iptal eder.
- `hepsi:true`: tüm pending rez'leri iptal eder.

---

### Mola kanalı komutları

#### `/mola sure:10`
- Sadece **rez zamanı geldiyse** başlar (rez başlangıcından itibaren 5 dk pencere).
- Geç başlanırsa mola süresi kısalır (bitiş yine rez bitişidir).
- Kalan süre < 5 dk ise başlatmaz.

#### `/acil sure:10`
- Rez olmadan başlar.
- Normal mola 1 saat kuralını bypass eder.

#### `/ekstra sure:10`
- Vardiya **dışında** kullanılır.
- Yalnızca admin tarafından verilmiş ekstra hakla çalışır.

#### `/devam`
- Aktif molayı bitirir.
- Mola bitişinden **2 dk** fazla geç kalındıysa geç kalma bilgisi yazar.

#### `/hak`
- 10/20 haklarını (boş/rez/kullanılan) ve aktif mola bilgisini gösterir.

---

### Admin komutları (`/admin`)

> Yalnızca `ADMIN_ROLE_ID` rolüne sahip kişiler veya sunucu yöneticileri kullanabilir.

| Komut | Açıklama |
|---|---|
| `/admin rapor` | Vardiya mola raporu (günlük/haftalık/aylık) |
| `/admin kullanici` | Belirli kullanıcının mola geçmişi |
| `/admin hak-ver` | Kullanıcıya ekstra mola hakkı ver |
| `/admin hak-al` | Kullanıcıdan mola hakkı al |
| `/admin mola-bitir` | Kullanıcının aktif molasını zorla sonlandır |
| `/admin rez-ver` | Kullanıcı adına rezervasyon oluştur (hak düşülmez) |
| `/admin rez-iptal` | Kullanıcının rezervasyonunu iptal et |
| `/admin mola-al` | Kendi admin molasını başlat (kural yok) |
| `/admin devam` | Kendi admin molasını bitir |
| `/admin restart` | Botu yeniden başlat |

---

## 6) Kurallar Özeti

- İlk 30 dk & son 30 dk içinde mola/rez yok.
- Aynı kullanıcı için iki rez başlangıcı arası min **1 saat**.
- Rez aldıktan sonra yeni rez alabilmek için **30 dk** bekleme.
- Kapasite:
  - 10 dk: max 2
  - 20 dk: max 1
- Rez başlangıcından sonra 5 dk içinde `/mola` yapılmazsa rez iptal olur (hak geri).
- `/devam` yazılmazsa 10 dk sonra auto-close.

---

## 7) Veri Saklama

Bot veriyi aynı klasörde **data.json** içinde tutar (basit kalıcı DB). `gitignore` içinde tutulur.

---

## 8) Bot İzinleri

Botun çalışması için gereken Discord izinleri:

- `Send Messages`
- `Use Application Commands`
- `Read Message History`
- `View Channel`
- `Manage Messages` (opsiyonel, ephemeral mesaj silme için)

> Nickname okuyabilmesi için kullanıcıların nick'i sunucu içinde görünür olmalı.
