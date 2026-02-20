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

> Zaman dilimi: `TZ` ile belirlenir (varsayılan: `Europe/Berlin`).

---

## 1) Kurulum

### Gerekenler
- Node.js **18+**
- Discord bot token

### Dosyaları indir

Bu klasörde:

```bash
npm install
```

### .env oluştur

`.env.example` dosyasını kopyala:

```bash
cp .env.example .env
```

`.env` içine şu alanları gir:

- `DISCORD_TOKEN`
- `CLIENT_ID` (Discord Developer Portal → Application ID)
- `GUILD_ID` (sunucu ID)
- 6 kanal ID’si:
  - `MORNING_MOLA_CHANNEL_ID`
  - `MORNING_REZ_CHANNEL_ID`
  - `EVENING_MOLA_CHANNEL_ID`
  - `EVENING_REZ_CHANNEL_ID`
  - `NIGHT_MOLA_CHANNEL_ID`
  - `NIGHT_REZ_CHANNEL_ID`

> Kanal ID almak için Discord’da Developer Mode aç → kanala sağ tık → Copy ID.

---

## 2) Slash Komutları Yükleme

Discord’a komutları eklemek için:

```bash
npm run deploy
```

Komutlar **guild** seviyesine yüklenir (anında görünür).

---

## 3) Botu Çalıştırma

```bash
npm start
```

---

## 4) Nickname Vardiya Formatı

Bot, kullanıcı vardiyasını **nick** üzerinden okur.

Nick içinde şu pattern olmalı:

- `08.00 - 16.00`
- `10.00 - 18.00`
- `16.00 - 00.00`
- `18.00 - 02.00`
- `20.00 - 04.00`
- `00.00 - 08.00`

Örnek nick:
- `Ahmet | 16.00 - 00.00`

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
- Kendi pending rez’lerini ve havuzun o anki durumunu gösterir.

#### `/reziptal`
- Parametresiz: en yakın pending rezi iptal eder.
- `saat:HH:MM`: o saatli rezi iptal eder.
- `hepsi:true`: tüm pending rez’leri iptal eder.

### Mola kanalı komutları

#### `/mola sure:10`
- Sadece **rez zamanı geldiyse** başlar (rez başlangıcından itibaren 5 dk pencere).
- Geç başlanırsa mola süresi kısalır (bitiş yine rez bitişidir).
- Kalan süre < 5 dk ise başlatmaz.

#### `/acil sure:10`
- Rez olmadan başlar.
- Normal mola 1 saat kuralını bypass eder.

#### `/devam`
- Aktif molayı bitirir.
- Mola bitişinden **2 dk** fazla geç kalındıysa geç kalma bilgisi yazar.

#### `/hak`
- 10/20 haklarını (boş/rez/kullanılan) ve aktif mola bilgisini gösterir.

---

## 6) Kurallar Özeti

- İlk 30 dk & son 30 dk içinde mola/rez yok.
- Aynı kullanıcı için iki rez başlangıcı arası min **1 saat**.
- Kapasite:
  - 10 dk: max 2
  - 20 dk: max 1
- Rez başlangıcından sonra 5 dk içinde `/mola` yapılmazsa rez iptal olur (hak geri).
- `/devam` yazılmazsa 10 dk sonra auto-close.

---

## 7) Veri Saklama

Bot veriyi aynı klasörde **data.json** içinde tutar (basit kalıcı DB). `gitignore` içinde tutulur.

---

## 8) Notlar

- Botun ilgili kanallara mesaj atabilmesi için `Send Messages` ve slash komutları kullanabilmesi için `Use Application Commands` izni olmalı.
- Nickname okuyabilmesi için kullanıcıların nick’i sunucu içinde görünür olmalı.

