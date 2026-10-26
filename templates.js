const { getFirestore } = require('firebase-admin/firestore');

const DEFAULT_TPL = {
  pm_redirect: '📩 Silakan buka chat pribadi (PM) dengan bot ini lalu ketik /beli untuk mendapatkan link pembayaran pribadi Anda.',
  beli_maintenance: '🛠️ <b>Maintenance</b>\n\nSistem sedang dalam pemeliharaan. Penjualan dibuka kembali setelah selesai. Terima kasih! 🙏',

  beli_intro: '🌌 <b>Aphelion Membership Bot</b>\n\nHalo, <b>{nama}</b>!\n\n📌 Status langganan: {status}\n\n💳 <b>CARA BAYAR TERMUDAH:</b>\nKetuk tombol <b>💳 BAYAR VIA QRIS</b> di bawah → gambar QRIS resmi + panduan lengkap muncul langsung di chat ini.\nBayar dari aplikasi apa pun (GoPay, OVO, DANA, ShopeePay, m-banking), lalu kirim screenshot bukti ke sini.\nToken lisensi & invite VIP dikirim otomatis setelah verifikasi.\n\n🎁 Mau coba dulu gratis? Tekan tombol <b>COBA TRIAL GRATIS</b> — {trialDays} hari tanpa bayar.',

  pay_qris: `💳 <b>PEMBAYARAN VIA QRIS — CEPAT & RESMI</b>

🏪 Merchant : <b>APHELION (MODS & TOOLS)</b>
🆔 NMID : ID1026608652578
💰 Minimal : <b>Rp {price}</b> (nominal bebas, lebih = apresiasi)
⏳ Dapatkan : <b>VIP {planDays} hari</b> untuk semua nominal

━━━━━━━━━━━━━━━━━━━━━━━
📖 <b>CARA BAYAR (±2 MENIT)</b>
━━━━━━━━━━━━━━━━━━━━━━━
1️⃣ Simpan gambar QRIS di atas ke galeri HP
2️⃣ Buka GoPay / OVO / DANA / ShopeePay / m-banking
3️⃣ Pilih <b>Scan QRIS</b> → ketuk ikon galeri → pilih gambar
4️⃣ Masukkan nominal (min. Rp {price}) → lanjut
5️⃣ Pastikan nama merchant = <b>APHELION (MODS & TOOLS)</b>
6️⃣ Bayar → <b>screenshot bukti sukses</b> (nominal & status terlihat)
7️⃣ Kirim screenshot ke chat ini 📸
8️⃣ Ketik nominalnya, contoh: <code>bayar 10000</code>

━━━━━━━━━━━━━━━━━━━━━━━
🔑 <b>KODE LISENSI TURUN OTOMATIS</b>
━━━━━━━━━━━━━━━━━━━━━━━
✅ Verifikasi owner/admin ±15 menit
✅ Bot kirim <b>2 token lisensi</b> (1 per app) + invite grup VIP
✅ Masukkan token di layar login app → akses aktif!

⚠️ Selain merchant di atas = BUKAN Aphelion.
🚫 Jangan transfer ke rekening/e-wallet pribadi siapapun.`,

  pay_guide: `📖 <b>PANDUAN LENGKAP: BAYAR → LISENSI</b>

<b>TAHAP 1 — BAYAR VIA QRIS</b>
• Ketuk 🔙 KEMBALI KE QRIS untuk melihat gambar QRIS
• Bisa dibayar dari aplikasi apa pun: GoPay, OVO, DANA, ShopeePay, BCA, Mandiri, BNI, BRI, dll
• Nominal bebas (min. Rp {price}) — semua nominal dapat akses VIP {planDays} hari penuh
• Nama merchant wajib: APHELION (MODS & TOOLS)

<b>TAHAP 2 — KIRIM BUKTI KE CHAT INI</b>
• Screenshot halaman SUKSES (nominal, merchant, waktu & status terlihat jelas)
• Kirim fotonya ke chat ini 📸
• Lalu ketik nominalnya, contoh: <code>bayar 10000</code>
• Bebas urutan: foto dulu atau nominal dulu — bot otomatis menjodohkan (maks jeda 15 menit)

<b>TAHAP 3 — TERIMA 2 KODE LISENSI</b>
• Owner/admin1 verifikasi bukti (±15 menit)
• Bot kirim <b>2 token</b>:
  🚗 1 token untuk <b>App Grab Driver</b>
  👻 1 token untuk <b>App Phantom</b>
• Buka masing-masing app → layar login → isi username TG + token → MASUK
• Selesai! Akses VIP aktif {planDays} hari di kedua app

💡 <b>TIPS & ATURAN</b>
• 1 token = 1 perangkat per app setelah login pertama
• Screenshot <b>kedua token</b> untuk backup pribadi
• Token hilang / ganti HP? Ketuk 🔑 di layar login → pemulihan mandiri
• Bukti editan/palsu = blacklist permanen tanpa refund
• Nominal di atas minimal = dianggap donasi apresiasi dev 💜`,

  welcome_public: `👋 Halo <b>{nama}</b>! Selamat datang di komunitas Aphelion

📋 <b>PROFIL KAMU</b>
🆔 UID: <code>{uid}</code>
👤 Username: @{username}
📅 Bergabung: {tanggal}

━━━━━━━━━━━━━━━━━━━━━━━

🏠 <b>APA ITU APHELION?</b>

Aphelion = <b>Tools Premium</b> untuk:
🛵 Driver Ojol (Grab, Gojek, dll)
🎮 Mobile Gamer
📍 Fake GPS & Location Spoofing
🔧 Produktivitas & Automation

━━━━━━━━━━━━━━━━━━━━━━━

🚀 <b>APHELION VIP = AKSES PENUH</b>

✅ Unlock semua fitur premium
✅ Update prioritas & beta access
✅ Support langsung developer
✅ Bebas iklan & watermark
✅ Anti-banned system

━━━━━━━━━━━━━━━━━━━━━━━

🎁 <b>PILIH JALAN MASUK</b>

<b>1️⃣ TRIAL GRATIS {trialDays} HARI</b>
   → 1x seumur hidup per device
   → Full akses, tanpa batas
   → Coba dulu sebelum commit

<b>2️⃣ DONASI VIP (Mulai Rp {price})</b>
   → Akses {planDays} hari penuh
   → Donasi lebih = apresiasi dev
   → Semua nominal = akses sama
   → Pembayaran QRIS / GoPay

━━━━━━━━━━━━━━━━━━━━━━━

⚠️ <b>PERINGATAN KEAMANAN</b>

🚫 Admin & bot <b>TIDAK PERNAH</b>:
   • Japri / chat personal duluan
   • Minta password / OTP / token
   • Minta transfer ke rekening pribadi

✅ <b>ADMIN RESMI</b> (selain ini = PENIPU):
   👑 @Mr_PH0B05 (Owner)
   🛡️ @Draven_89 (Admin)
   🛡️ @MrDeimos823 (Admin)

💳 <b>PEMBAYARAN RESMI</b>:
   • QRIS Merchant (scan code)
   • GoPay Merchant (invoice otomatis)
   • Token dikirim otomatis setelah bayar

━━━━━━━━━━━━━━━━━━━━━━━

👇 <b>KETUK TOMBOL DI BAWAH</b>
(Otomatis buka chat pribadi bot)`,

    welcome_vip: '🌟 <b>SELAMAT DATANG DI APHELION PRIME!</b>\n\nHalo, <a href="tg://user?id={uid}">{nama}</a>! Selamat bergabung di lingkaran VIP. 🌌\n\nDi sini Anda mendapatkan:\n✅ Akses fitur & konten premium\n✅ Info update & prioritas support\n✅ Komunitas eksklusif\n\nSimpan baik-baik token akses Anda. Jika butuh bantuan, hubungi admin.\n\nNikmati pengalamannya! 🚀\n\n— Manajemen Aphelion',

  // 🌟 BARU: Kartu welcome khusus grup VIP (identitas + masa aktif + lisensi)
  welcome_vip_card: `🌟 <b>SELAMAT DATANG DI APHELION PRIME • VIP</b>

👋 Halo <b>{firstName}</b>! Selamat bergabung di lingkaran eksklusif.

📋 <b>IDENTITAS MEMBER</b>
🆔 UID: <code>{uid}</code>
👤 Telegram: @{username}
🎉 Nama: <b>{firstName}</b>

💎 <b>KARTU KEANGGOTAAN</b>
📅 Join grup : {joinDate}
{expiredLabel}
⏱️ Durasi    : <b>{planDays} hari</b>
📱 Lisensi  : {licenseStatus}

🔔 <b>PENGINGAT OTOMATIS</b>
Bot mengingatkan kamu H-3 & H-1 sebelum
masa aktif berakhir via chat pribadi.

⚠️ <b>ATURAN BERLAKU</b>
Saat masa aktif berakhir, bot otomatis
mengeluarkan kamu dari grup ini.
Perpanjang kapan saja: ketik <code>/beli</code> di bot.

Selamat menikmati fasilitas VIP! 🌌
— Manajemen Aphelion`,

  // 🚨 BARU: Reminder H-1 dipost di grup VIP (tag @username)
  reminder_h1_group: `🚨 <b>PENGINGAT AKHIR</b>

@{username} — masa aktif VIP kamu berakhir <b>besok</b>
📅 Expired: {tanggal}

Perpanjang hari ini biar gak ke-kick otomatis
👉 ketik <code>/beli</code> di bot`,

  // 👋 BARU: Pengumuman kick di grup VIP
  kick_announcement: `👋 <b>@{username}</b> keluar otomatis karena masa aktif berakhir
📅 Expired: {tanggal}

Pintu VIP terbuka kapan saja — perpanjang via bot. 🌌`,

  // 🔥 UPDATED: multi-token format (2 app)
  payment_success: `✅ <b>Pembayaran Terverifikasi</b>

Terima kasih! Langganan VIP Anda aktif <b>{planDays} hari</b> mulai login pertama di masing-masing app.

🔑 <b>KODE LISENSI ANDA ({tokens_count} token):</b>

{tokens}

{invite}

⚠️ <b>ATURAN PENTING:</b>
• 1 kode = 1 perangkat per app (setelah login pertama)
• Simpan <b>kedua kode</b> dengan screenshot
• Jangan bagikan ke siapa pun
• Token hilang? Ketuk 🔑 di layar login → pemulihan mandiri`,

  expired_dm: '⏳ <b>MASA AKTIF BERAKHIR</b>\n\nLangganan VIP Anda telah berakhir hari ini. Akses grup & fitur premium dinonaktifkan.\n\nIngin bergabung lagi? Ketik /beli untuk perpanjang. Sampai jumpa di dalam! 🌌',
  reminder_h3: '⏰ <b>PENGINGAT RAMAH</b>\n\nHalo! Langganan VIP Anda akan berakhir dalam <b>3 hari</b> ({tanggal}).\n\nPerpanjang sekarang agar tetap nyaman di grup VIP tanpa jeda:\n👉 ketik /beli di chat ini.\n\nTerima kasih! 🌌',
  reminder_h1: '🚨 <b>PEMBERITAHUAN TERAKHIR</b>\n\nLangganan VIP Anda berakhir <b>besok/hari ini</b> ({tanggal}). Setelah itu Anda otomatis dikeluarkan dari grup VIP.\n\n👉 Ketik /beli untuk perpanjang sekarang. Sampai jumpa di dalam! 🌌',
  maintenance_on: '🛠 <b>INFO PEMELIHARAAN</b>\n\nKepada keluarga besar Aphelion,\nKami sedang melakukan pemeliharaan sistem demi kualitas layanan yang lebih baik.\n\n⏳ Estimasi durasi: <b>{durasi}</b>\n🔒 Selama pemeliharaan, pembelian & perpanjangan dijeda sementara.\n✅ Langganan yang sudah aktif tetap aman & bisa dipakai normal.\n\nKami akan umumkan kembali saat semua normal. Terima kasih atas pengertiannya! 🙏\n\n— Manajemen Aphelion',
  maintenance_off: '✅ <b>SEMUA LAYANAN NORMAL KEMBALI</b>\n\nPemeliharaan telah selesai! Pembelian & perpanjangan sudah dibuka kembali.\n\nTerima kasih atas kesabaran Anda, keluarga Aphelion! 🌌\n\n— Manajemen Aphelion',
  settings_info: '💡 <b>INFO UPDATE</b>\n\n📌 Minimal donasi: <b>Rp {harga}</b>\n⏳ Durasi aktif: <b>{hari} hari</b>\n\nLangganan yang sudah berjalan tidak terpengaruh. Terima kasih atas dukungan Anda! 🙏\n\n— Manajemen Aphelion',
  broadcast_kop: '📢 <b>PENGUMUMAN APHELION</b>\n\n{text}\n\n— Manajemen Aphelion',
  ban_dm: '🚫 <b>Akses Dicabut</b>\n\nAlasan: <i>{alasan}</i>\nJika merasa keliru, hubungi support.',
  resend_dm: '🔑 <b>Token akses Anda:</b>\n<code>{token}</code>\n\n🚪 Ketuk tombol di bawah untuk masuk VIP:',
  trial_success: '🎁 <b>TRIAL AKTIF!</b>\n\nHai <b>{nama}</b>! Token trial Anda siap:\n\n🔑 <code>{token}</code>\n⏳ Berlaku <b>{hari} hari</b> (mulai saat login pertama)\n📱 App: <code>{package}</code>\n\nGunakan token ini di layar login aplikasi.\n\n⚠️ Kode ini rahasia — 1 akun = 1 perangkat. Jangan dibagikan.',
  trial_disabled: '🔒 <b>Trial Ditutup Sementara</b>\n\nProgram trial sedang tidak dibuka. Pantau pengumuman di grup untuk info terbaru.\n\nAtau lanjut langsung sebagai member VIP:\n👉 ketik /beli',
  trial_used: '⚠️ <b>Trial Sudah Pernah Dipakai</b>\n\nAkun Telegram Anda sudah pernah menggunakan trial (1x seumur hidup per akun).\n\nLanjut sebagai member VIP untuk akses penuh:\n👉 ketik /beli',
  trial_quota_full: '⏳ <b>Kuota Trial Hari Ini Penuh</b>\n\nSemua slot trial untuk hari ini sudah terpakai. Silakan coba lagi besok.\n\nAtau langsung jadi member VIP tanpa antri:\n👉 ketik /beli',
  trial_not_member: '📢 <b>Wajib Join Grup Dulu</b>\n\nSebelum ambil trial, silakan bergabung di grup publik Aphelion terlebih dahulu.\n\nSetelah join, tekan tombol 🎁 COBA TRIAL lagi di chat ini.',
  trial_expired: '⏳ <b>TRIAL SELESAI</b>\n\nHai <b>{nama}</b>, masa trial Anda telah berakhir hari ini.\n\nKalau cocok, lanjut jadi member VIP biar akses tetap jalan tanpa jeda:\n👉 ketik /beli\n\nTerima kasih sudah mencoba! 🙏',
  trial_device_used: '🔒 <b>Perangkat Sudah Pernah Trial</b>\n\nHP ini sudah pernah menggunakan trial dengan akun lain (1 device = 1 trial seumur hidup).\n\nLanjut VIP untuk akses penuh:\n👉 ketik /beli'
};

const VARS = {
  pm_redirect: [], beli_maintenance: [],
  beli_intro: ['nama', 'status', 'link', 'trialDays'],
  pay_qris: ['price', 'planDays'],
  pay_guide: ['price', 'planDays'],
  welcome_public: ['nama', 'uid', 'username', 'tanggal', 'trialDays', 'price', 'planDays'],
    welcome_vip: ['nama', 'uid'],
  welcome_vip_card: ['firstName', 'uid', 'username', 'joinDate', 'expiredLabel', 'planDays', 'licenseStatus'],
  reminder_h1_group: ['username', 'tanggal'],
  kick_announcement: ['username', 'tanggal'],
  payment_success: ['planDays', 'tokens', 'tokens_count', 'invite'],
  expired_dm: [],
  reminder_h3: ['tanggal'], reminder_h1: ['tanggal'],
  maintenance_on: ['durasi'], maintenance_off: [], settings_info: ['harga', 'hari'],
  broadcast_kop: ['text'], ban_dm: ['alasan'], resend_dm: ['token'],
  trial_success: ['nama', 'token', 'hari', 'package'],
  trial_disabled: [], trial_used: [], trial_quota_full: [], trial_not_member: [],
  trial_expired: ['nama'], trial_device_used: []
};

const getTpl = async (key, vars = {}) => {
  let text = DEFAULT_TPL[key] || '';
  try {
    const d = await getFirestore().collection('templates').doc(key).get();
    if (d.exists && d.data().text) text = d.data().text;
  } catch (e) { /* pakai default */ }
  for (const [k, v] of Object.entries(vars)) {
    text = text.split('{' + k + '}').join(String(v));
  }
  return text;
};

module.exports = { DEFAULT_TPL, VARS, getTpl };
