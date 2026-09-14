const { getFirestore } = require('firebase-admin/firestore');

const DEFAULT_TPL = {
  pm_redirect: '📩 Silakan buka chat pribadi (PM) dengan bot ini lalu ketik /beli untuk mendapatkan link pembayaran pribadi Anda.',
  beli_maintenance: '🛠️ <b>Maintenance</b>\n\nSistem sedang dalam pemeliharaan. Penjualan dibuka kembali setelah selesai. Terima kasih! 🙏',
  beli_intro: '🌌 <b>Aphelion Membership Bot</b>\n\nHalo, <b>{nama}</b>!\n\n📌 Status langganan: {status}\n\nKlik link pembayaran pribadi Anda di bawah. Identitas Telegram terdeteksi otomatis — tidak perlu mengetik username.\n\n👉 <b><a href="{link}">[ BUKA HALAMAN PEMBAYARAN ]</a></b>\n\nAtau coba dulu gratis tanpa bayar — tekan tombol 🎁 di bawah. Setelah pembayaran terverifikasi, token akses & undangan grup VIP dikirim otomatis ke chat ini.',
  welcome_public: '👋 Selamat datang di ruang publik Aphelion, <a href="tg://user?id={uid}">{nama}</a>!\n\nDi sini tempat info umum, pengumuman, dan komunitas.\nUntuk paket Premium/VIP, chat bot resmi kami dan ketik <b>/beli</b>.\n\n🎁 <b>Mau coba dulu?</b> Tekan tombol <b>COBA TRIAL</b> di bawah — gratis {trialDays} hari, tanpa bayar.',
  welcome_vip: '🌟 <b>SELAMAT DATANG DI APHELION PRIME!</b>\n\nHalo, <a href="tg://user?id={uid}">{nama}</a>! Selamat bergabung di lingkaran VIP. 🌌\n\nDi sini Anda mendapatkan:\n✅ Akses fitur & konten premium\n✅ Info update & prioritas support\n✅ Komunitas eksklusif\n\nSimpan baik-baik token akses Anda. Jika butuh bantuan, hubungi admin.\n\nNikmati pengalamannya! 🚀\n\n— Manajemen Aphelion',
  payment_success: '✅ <b>Pembayaran Terverifikasi</b>\n\nTerima kasih! Langganan VIP Anda aktif sampai <b>{tanggal}</b>.\n\n🔑 <b>Token akses Anda:</b>\n<code>{token}</code>\n\n{invite}\n\n⚠️ Token bersifat pribadi & terikat satu perangkat setelah aktivasi pertama. Jangan bagikan ke siapa pun.',
  expired_dm: '⏳ <b>MASA AKTIF BERAKHIR</b>\n\nLangganan VIP Anda telah berakhir hari ini. Akses grup & fitur premium dinonaktifkan.\n\nIngin bergabung lagi? Ketik /beli untuk perpanjang. Sampai jumpa di dalam! 🌌',
  reminder_h3: '⏰ <b>PENGINGAT RAMAH</b>\n\nHalo! Langganan VIP Anda akan berakhir dalam <b>3 hari</b> ({tanggal}).\n\nPerpanjang sekarang agar tetap nyaman di grup VIP tanpa jeda:\n👉 ketik /beli di chat ini.\n\nTerima kasih! 🌌',
  reminder_h1: '🚨 <b>PEMBERITAHUAN TERAKHIR</b>\n\nLangganan VIP Anda berakhir <b>besok/hari ini</b> ({tanggal}). Setelah itu Anda otomatis dikeluarkan dari grup VIP.\n\n👉 Ketik /beli untuk perpanjang sekarang. Sampai jumpa di dalam! 🌌',
  maintenance_on: '🛠 <b>INFO PEMELIHARAAN</b>\n\nKepada keluarga besar Aphelion,\nKami sedang melakukan pemeliharaan sistem demi kualitas layanan yang lebih baik.\n\n⏳ Estimasi durasi: <b>{durasi}</b>\n🔒 Selama pemeliharaan, pembelian & perpanjangan dijeda sementara.\n✅ Langganan yang sudah aktif tetap aman & bisa dipakai normal.\n\nKami akan umumkan kembali saat semua normal. Terima kasih atas pengertiannya! 🙏\n\n— Manajemen Aphelion',
  maintenance_off: '✅ <b>SEMUA LAYANAN NORMAL KEMBALI</b>\n\nPemeliharaan telah selesai! Pembelian & perpanjangan sudah dibuka kembali.\n\nTerima kasih atas kesabaran Anda, keluarga Aphelion! 🌌\n\n— Manajemen Aphelion',
  settings_info: '💡 <b>INFO UPDATE</b>\n\n📌 Minimal donasi: <b>Rp {harga}</b>\n⏳ Durasi aktif: <b>{hari} hari</b>\n\nLangganan yang sudah berjalan tidak terpengaruh. Terima kasih atas dukungan Anda! 🙏\n\n— Manajemen Aphelion',
  broadcast_kop: '📢 <b>PENGUMUMAN APHELION</b>\n\n{text}\n\n— Manajemen Aphelion',
  ban_dm: '🚫 <b>Akses Dicabut</b>\n\nAlasan: <i>{alasan}</i>\nJika merasa keliru, hubungi support.',
  resend_dm: '🔑 <b>Token akses Anda:</b>\n<code>{token}</code>\n\n🚪 Ketuk tombol di bawah untuk masuk VIP:',
  // ===== 🎁 TRIAL (BARU) =====
  trial_success: '🎁 <b>TRIAL AKTIF!</b>\n\nHai <b>{nama}</b>! Token trial Anda siap:\n\n🔑 <code>{token}</code>\n⏳ Berlaku <b>{hari} hari</b> (mulai saat login pertama)\n📱 App: <code>{package}</code>\n\nGunakan token ini di layar login aplikasi.\n\n⚠️ Kode ini rahasia — 1 akun = 1 perangkat. Jangan dibagikan.',
  trial_disabled: '🔒 <b>Trial Ditutup Sementara</b>\n\nProgram trial sedang tidak dibuka. Pantau pengumuman di grup untuk info terbaru.\n\nAtau lanjut langsung sebagai member VIP:\n👉 ketik /beli',
  trial_used: '⚠️ <b>Trial Sudah Pernah Dipakai</b>\n\nAkun Telegram Anda sudah pernah menggunakan trial (1x seumur hidup per akun).\n\nLanjut sebagai member VIP untuk akses penuh:\n👉 ketik /beli',
  trial_quota_full: '⏳ <b>Kuota Trial Hari Ini Penuh</b>\n\nSemua slot trial untuk hari ini sudah terpakai. Silakan coba lagi besok.\n\nAtau langsung jadi member VIP tanpa antri:\n👉 ketik /beli',
  trial_not_member: '📢 <b>Wajib Join Grup Dulu</b>\n\nSebelum ambil trial, silakan bergabung di grup publik Aphelion terlebih dahulu.\n\nSetelah join, tekan tombol 🎁 COBA TRIAL lagi di chat ini.',
  trial_expired: '⏳ <b>TRIAL SELESAI</b>\n\nHai <b>{nama}</b>, masa trial Anda telah berakhir hari ini.\n\nKalau cocok, lanjut jadi member VIP biar akses tetap jalan tanpa jeda:\n👉 ketik /beli\n\nTerima kasih sudah mencoba! 🙏',
  trial_device_used: '🔒 <b>Perangkat Sudah Pernah Trial</b>\n\nHP ini sudah pernah menggunakan trial dengan akun lain (1 device = 1 trial seumur hidup).\n\nLanjut VIP untuk akses penuh:\n👉 ketik /beli'
};

const VARS = {
  pm_redirect: [], beli_maintenance: [], beli_intro: ['nama', 'status', 'link', 'trialDays'],
  welcome_public: ['nama', 'uid', 'trialDays'], welcome_vip: ['nama', 'uid'],
  payment_success: ['tanggal', 'token', 'invite'], expired_dm: [],
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
