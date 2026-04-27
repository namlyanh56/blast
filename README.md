# 🚀 WA Blast System

Sistem automasi pengiriman pesan massal WhatsApp via **Baileys** dengan panel **Telegram Bot**.

**Stack:** Node.js · Express · PostgreSQL · Baileys · Telegram Bot API · Duitku

---

## 📁 Struktur File

```
wa-blast/
├── index.js                  ← Entry point utama
├── server.js                 ← Express API + Duitku webhook
├── package.json
├── .env.example
├── config/
│   └── db.js                 ← PostgreSQL connection pool
├── database/
│   └── schema.sql            ← DDL semua tabel
├── services/
│   ├── whatsapp.js           ← Baileys multi-session manager
│   └── payment.js            ← Duitku disbursement
├── bot/
│   ├── core.js               ← Bot instance + state machine
│   ├── router.js             ← Dispatcher utama
│   ├── admin.js              ← Semua handler menu admin
│   └── client.js             ← Semua handler menu client
└── utils/
    └── helper.js             ← Utilities (htmlToWa, parseTxt, dll)
```

---

## ⚙️ Setup di VPS Ubuntu/Debian

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
node -v   # v20.x.x
```

### 2. Install PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Buat user & database
sudo -u postgres psql -c "CREATE USER wablast WITH PASSWORD 'password_kuat_disini';"
sudo -u postgres psql -c "CREATE DATABASE wablast OWNER wablast;"
```

### 3. Clone / Upload project

```bash
# Upload ke VPS, lalu:
cd /home/ubuntu/wa-blast
npm install
```

### 4. Konfigurasi .env

```bash
cp .env.example .env
nano .env
```

Isi dengan data Anda:
```env
DATABASE_URL=postgresql://wablast:password_kuat_disini@localhost:5432/wablast
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
ADMIN_TELEGRAM_ID=123456789
DUITKU_MERCHANT_CODE=Dxxxxx
DUITKU_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DUITKU_BASE_URL=https://passport.duitku.com/webapi
PORT=3000
SESSION_DIR=./sessions
NODE_ENV=production
```

> **Cara dapat Telegram Bot Token:** Chat [@BotFather](https://t.me/BotFather) → `/newbot`
>
> **Cara dapat Admin ID:** Chat [@userinfobot](https://t.me/userinfobot)

### 5. Jalankan (Development)

```bash
node index.js
```

### 6. Jalankan sebagai Service (Production dengan PM2)

```bash
npm install -g pm2
pm2 start index.js --name "wa-blast"
pm2 startup
pm2 save

# Cek status
pm2 status
pm2 logs wa-blast
```

---

## 🔔 Setup Duitku Disbursement Callback

Di dashboard Duitku, set **Callback URL** disbursement ke:
```
http://IP_VPS_ANDA:3000/api/duitku/callback
```

Atau jika menggunakan domain + SSL:
```
https://domain.anda.com/api/duitku/callback
```

> Pastikan port 3000 terbuka di firewall:
> ```bash
> sudo ufw allow 3000
> ```

---

## 📱 Cara Penggunaan

### Sebagai Admin
1. Buka Telegram → cari bot Anda → `/start`
2. Panel Admin muncul otomatis (karena ID Anda = `ADMIN_TELEGRAM_ID`)

| Menu | Fungsi |
|------|--------|
| ⚙️ Setting Pesan | Edit teks + URL gambar (support HTML) |
| 🔘 Setting Button | Nama & URL tombol pada pesan |
| 👥 Navigator | Monitor semua client & sesi WA |
| 💰 Setting Harga | Tarif per pesan berhasil terkirim |
| 🎯 Setting Target | Upload TXT ribuan nomor target |
| 👤 Profil WA | Update foto/nama semua akun WA sekaligus |

### Sebagai Client
1. Buka Telegram → cari bot → `/start`
2. Panel Client muncul otomatis

| Menu | Fungsi |
|------|--------|
| ➕ Tambah Bot | Tambah akun WA baru via Pairing Code |
| 📋 Daftar Bot | Lihat status, logout akun |
| ⏸️ Jeda | Set delay per akun (ms) |
| ▶️ Start Blast | Mulai/stop pengiriman ke target |
| 📊 Log | Riwayat pengiriman per akun |
| 💸 Withdraw | Tarik saldo ke dompet digital |

---

## 🔐 Fitur Keamanan

- **Anti Duplikat:** Nomor yang sudah terkirim tidak akan dikirim lagi (UNIQUE constraint + status tracking)
- **Atomic target lock:** `SELECT ... FOR UPDATE SKIP LOCKED` mencegah race condition saat multi-akun blast bersamaan
- **Balance deduction atomic:** Saldo dikurangi secara atomic sebelum transfer Duitku
- **Auto-reconnect:** Sesi WA yang terputus reconnect otomatis setelah 8 detik
- **Ban detection:** Akun yang di-ban WhatsApp otomatis dihentikan + notif ke client
- **Fallback button:** Jika Baileys button API error, pesan tetap terkirim dengan format teks + URL

---

## 📊 Database Tables

| Tabel | Fungsi |
|-------|--------|
| `users` | Admin & semua client (telegram_id, balance) |
| `wa_sessions` | Sesi WhatsApp per client |
| `settings` | Konfigurasi global (pesan, button, harga) |
| `targets` | Daftar nomor target + status pending/sent/failed |
| `send_logs` | Log setiap pengiriman + biaya |
| `wallets` | Data dompet digital client |
| `withdrawals` | Riwayat penarikan saldo |

---

## 🛠️ Perintah Bot

| Command | Fungsi |
|---------|--------|
| `/start` | Buka menu utama |
| `/menu` | Sama dengan /start |
| `/cancel` | Batalkan input yang sedang berjalan |
| `/status` | *(Admin only)* Lihat status sistem ringkas |

---

## ⚠️ Catatan Penting

- **Jeda minimal 3000ms** direkomendasikan untuk menghindari ban WhatsApp
- **1 akun WA** idealnya kirim maks 200-500 pesan/hari untuk keamanan
- File TXT target maksimal **500.000 nomor per upload** (bisa upload berkali-kali)
- Nomor format: `08xxx`, `628xxx`, atau `+628xxx` — semua diterima otomatis
- Backup folder `sessions/` secara berkala untuk menghindari re-login

---

## 🆘 Troubleshooting

**Bot tidak merespons:**
```bash
pm2 logs wa-blast --lines 50
```

**Database error:**
```bash
sudo -u postgres psql -d wablast -c "\dt"
```

**Sesi WA tidak konek:**
- Pastikan folder `sessions/` ada dan writable
- Coba logout akun dari menu Daftar Bot, lalu tambah ulang

**Port 3000 tidak bisa diakses:**
```bash
sudo ufw status
sudo ufw allow 3000/tcp
```
