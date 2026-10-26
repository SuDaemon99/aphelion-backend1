// finance.js — MODUL PEMBUKUAN ATOMIK APHELION
// Aturan emas Firestore: dalam runTransaction, SEMUA READ dulu, BARU WRITE.
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { createPendingLicense } = require('./licenses');

// 🔥 SATU-SATUNYA PINTU PENCATATAN TRANSAKSI (jurnal + buku besar atomik)
async function recordTransaction(db, tx) {
  const {
    orderId, uid, amount, channel = 'gopay', mode = 'production',
    paidAt = new Date().toISOString(), source = 'manual',
    note = null, createdBy = null, status = 'settlement', email = null
  } = tx;
  if (!orderId) throw new Error('orderId wajib');
  if (!amount || amount <= 0) throw new Error('amount wajib > 0');
  const dateKey = String(paidAt).slice(0, 10);

  await db.runTransaction(async (t) => {
    const txRef = db.collection('transactions').doc(orderId);
    const dayRef = db.collection('finance_daily').doc(dateKey);
    const totRef = db.collection('finance_total').doc('all');

    // ✅ FASE 1: SEMUA READ DILAKUKAN DULUAN (wajib sebelum write apa pun)
    const exist = await t.get(txRef);
    const day = await t.get(dayRef);

    if (exist.exists) throw new Error('OrderId sudah tercatat (double entry ditolak)');

    // ✅ FASE 2: BARU SEMUA WRITE (tidak ada read lagi setelah titik ini)
    t.set(txRef, {
      orderId, uid: uid || null, amount, status, channel, mode,
      email, note, source, createdBy, paidAt,
      createdAt: new Date().toISOString()
    });

    if (day.exists) {
      t.update(dayRef, {
        gross: FieldValue.increment(amount),
        count: FieldValue.increment(1),
        [`byChannel.${channel}`]: FieldValue.increment(amount)
      });
    } else {
      t.set(dayRef, { date: dateKey, gross: amount, count: 1, byChannel: { [channel]: amount } });
    }

    t.set(totRef, { gross: FieldValue.increment(amount), count: FieldValue.increment(1) }, { merge: true });
  });

  return { orderId, dateKey };
}

// 🔥 AKTIVASI USER SETELAH PAYMENT DISAHKAN (untuk Midtrans webhook — flow lama 1 token)
async function activatePaymentUser(db, uid, planDays, channel) {
  const tokenMod = 'APHELION-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiredDate = new Date();
  expiredDate.setDate(expiredDate.getDate() + planDays);

  let username = null;
  try {
    const chatInfo = await db.collection('telegram_chats').doc(uid).get();
    if (chatInfo.exists) username = chatInfo.data().username || null;
  } catch (e) { /* abaikan */ }

  const existingUser = await db.collection('users').doc(uid).get();
  const isNewUser = !existingUser.exists;

  await db.collection('users').doc(uid).set({
    uid, username, email: `gopay_${uid}@aphelion.id`,
    token: tokenMod,
    deviceId: existingUser.exists ? existingUser.data().deviceId : null,
    expiredAt: expiredDate, status: 'ACTIVE',
    source: channel || 'gopay', tier: 'vip',
    packageName: existingUser.exists ? existingUser.data().packageName : null,
    remindedH3: false, remindedH1: false,
    createdAt: existingUser.exists && existingUser.data().createdAt ? existingUser.data().createdAt : new Date().toISOString()
  });

  try { await db.collection('trial_claims').doc(uid).delete(); } catch (e) { /* ignore */ }

  return { token: tokenMod, expiredAt: expiredDate, username, isNewUser };
}

// 🔥 APPROVE PENDING PAYMENT — GENERATE 1 TOKEN PER PACKAGE AKTIF (multi-app) + STAMP OWNER TG UID
async function approvePendingPayment(db, pendingId, byName, editedAmount) {
  const ref = db.collection('pending_payments').doc(pendingId);
  let p = null;
  try {
    await db.runTransaction(async (t) => {
      const d = await t.get(ref);           // read dulu
      if (!d.exists) throw new Error('Data tidak ditemukan');
      if (d.data().status !== 'pending') throw new Error('Sudah diproses sebelumnya (' + d.data().status + ')');
      t.update(ref, { status: 'processing', approvedBy: byName, approvedAt: new Date().toISOString() }); // write setelah semua read
      p = d.data();
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const amount = (editedAmount && editedAmount > 0) ? editedAmount : p.amount;
  const orderId = 'GP-' + pendingId.toUpperCase().slice(0, 10);
  try {
    const setDoc = await db.collection('settings').doc('app').get();
    const planDays = (setDoc.exists && setDoc.data().planDays) ? parseInt(setDoc.data().planDays) : 30;

    // 🔥 AMBIL SEMUA PACKAGE AKTIF (otomatis: grab + phantom + apa pun yang aktif)
    const pkgSnap = await db.collection('packages').where('active', '==', true).get();
    const activePackages = pkgSnap.docs.map(d => d.data().packageName);

    if (activePackages.length === 0) {
      throw new Error('Tidak ada package aktif di database. Hubungi owner untuk setup packages.');
    }

    // 🔥 GENERATE 1 PENDING LICENSE PER PACKAGE AKTIF (multi-token) + STAMP OWNER TG UID
    const tokens = [];
    for (const pkg of activePackages) {
      const { id, code, masked } = await createPendingLicense(db, {
        packageName: pkg,
        durationDays: planDays,
        createdBy: byName,
        source: 'gopay_proof'
      });
      // Stamp username + OWNER TG UID ke doc user (patokan sync check & admin panel)
      await db.collection('users').doc(id).update({
        username: p.username || null,
        ownerTgUid: String(p.uid),   // 🔥 BARU: UID Telegram asli pengirim bukti
        source: 'gopay_proof',
        createdBy: byName
      });
      tokens.push({ code, masked, packageName: pkg, id });
    }

    // Catat 1 transaksi (total amount, dengan metadata jumlah token)
    await recordTransaction(db, {
      orderId, uid: p.uid, amount, channel: p.channel || 'gopay',
      source: 'gopay_proof', createdBy: byName, note: p.caption || null
    });

    await ref.update({
      status: 'approved',
      finalAmount: amount,
      orderId,
      tokenCount: tokens.length,
      tokens: tokens.map(t => ({ code: t.masked, packageName: t.packageName }))
    });

    return {
      ok: true,
      uid: p.uid,
      amount,
      orderId,
      approvedBy: byName,
      chatId: p.chatId || p.uid,
      username: p.username || null,
      tokens,                  // array of {code, masked, packageName, id}
      token: tokens[0].code,   // backward compat untuk Midtrans webhook lama
      planDays,
      tokenCount: tokens.length
    };
  } catch (e) {
    // rollback: kembalikan ke pending biar bisa dicoba lagi
    await ref.update({ status: 'pending', approvedBy: null, approvedAt: null }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// 🔥 EFEK DOMINO SETELAH APPROVE: DM user (semua token) + invite VIP + push FCM + ops feed
async function finalizeApprovedPayment(db, helpers, r) {
  const { sendTG, getTpl, createInviteLink, vipGroupId, pushAll, notifyOps } = helpers;

  // 1. DM USER dengan semua token (format dinamis per-package)
  try {
    const tokenLines = (r.tokens || []).map(t => {
      const shortPkg = t.packageName.split('.').pop();
      let label = `📱 <b>${shortPkg}</b>`;
      if (t.packageName.includes('grab') || t.packageName.includes('driver')) label = '🚗 <b>App Grab Driver</b>';
      else if (t.packageName.includes('phantom')) label = '👻 <b>App Phantom</b>';
      return `${label}:\n<code>${t.code}</code>`;
    }).join('\n\n');

    let inviteText = '⚠️ Link invite VIP gagal dibuat otomatis.';
    let inviteMarkup = undefined;
    try {
      const invite = await createInviteLink(vipGroupId, { member_limit: 1 });
      inviteText = '🚪 Ketuk tombol di bawah untuk masuk (link sekali pakai):';
      inviteMarkup = { inline_keyboard: [[{ text: '🚪 MASUK GRUP VIP', url: invite.invite_link }]] };
    } catch (e) { /* abaikan */ }

    const msgText = await getTpl('payment_success', {
      planDays: r.planDays || 30,
      tokens: tokenLines || '⚠️ Token tidak tersedia',
      tokens_count: r.tokenCount || (r.tokens ? r.tokens.length : 1),
      invite: inviteText
    });
    await sendTG(r.chatId, msgText, { parse_mode: 'HTML', ...(inviteMarkup ? { reply_markup: inviteMarkup } : {}) });
  } catch (e) { console.error('DM payment success gagal:', e.message); }

  // 2. Push FCM ke admin
  try {
    const tokenCount = r.tokenCount || (r.tokens ? r.tokens.length : 1);
    if (pushAll) await pushAll(
      '💰 Pembayaran Masuk!',
      `Rp ${r.amount.toLocaleString('id-ID')} • UID ${r.uid} • approve: ${r.approvedBy} • ${tokenCount} token`,
      'pay'
    );
  } catch (e) { /* abaikan */ }

  // 3. Notify ops feed
  try {
    const tokenPreview = (r.tokens || []).map(t => `${t.packageName.split('.').pop()}: ${t.masked}`).join(' • ');
    if (notifyOps) await notifyOps(
      `💰 <b>APPROVED</b> oleh ${r.approvedBy}\nRp ${r.amount.toLocaleString('id-ID')} • UID <code>${r.uid}</code> • ${r.orderId}\n<b>${r.tokenCount || 1} token:</b> ${tokenPreview}`,
      { safe: `💰 Approved ${r.approvedBy} • Rp ${r.amount.toLocaleString('id-ID')} (${r.tokenCount || 1} token)`, type: 'pay' }
    );
  } catch (e) { /* abaikan */ }
}

module.exports = { recordTransaction, activatePaymentUser, approvePendingPayment, finalizeApprovedPayment };
