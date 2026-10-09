// finance.js — MODUL PEMBUKUAN ATOMIK APHELION
// Satu pintu pencatatan: jurnal (transactions) + buku besar (finance_daily/total)
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

// 🔥 SATU-SATUNYA PINTU PENCATATAN TRANSAKSI (anti bocor: jurnal & buku besar selalu sinkron)
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

    const exist = await t.get(txRef);
    if (exist.exists) throw new Error('OrderId sudah tercatat (double entry ditolak)');

    t.set(txRef, {
      orderId, uid: uid || null, amount, status, channel, mode,
      email, note, source, createdBy, paidAt,
      createdAt: new Date().toISOString()
    });

    const day = await t.get(dayRef);
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

// 🔥 AKTIVASI USER SETELAH PAYMENT DISAHKAN (logika sama persis dengan webhook Midtrans)
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
    uid, username, email: emailSafe(uid),
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
const emailSafe = (uid) => `gopay_${uid}@aphelion.id`;

// 🔥 APPROVE PENDING PAYMENT (anti double-approve via transaksi status flip)
async function approvePendingPayment(db, pendingId, byName, editedAmount) {
  const ref = db.collection('pending_payments').doc(pendingId);
  let p = null;
  try {
    await db.runTransaction(async (t) => {
      const d = await t.get(ref);
      if (!d.exists) throw new Error('Data tidak ditemukan');
      if (d.data().status !== 'pending') throw new Error('Sudah diproses sebelumnya (' + d.data().status + ')');
      t.update(ref, { status: 'processing', approvedBy: byName, approvedAt: new Date().toISOString() });
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

    await recordTransaction(db, {
      orderId, uid: p.uid, amount, channel: p.channel || 'gopay',
      source: 'gopay_proof', createdBy: byName, note: p.caption || null
    });
    const act = await activatePaymentUser(db, p.uid, planDays, 'gopay');
    await ref.update({ status: 'approved', finalAmount: amount, orderId });

    return {
      ok: true, uid: p.uid, amount, orderId, approvedBy: byName,
      chatId: p.chatId || p.uid, username: act.username || p.username || null,
      token: act.token, expiredAt: act.expiredAt, isNewUser: act.isNewUser
    };
  } catch (e) {
    await ref.update({ status: 'pending', approvedBy: null, approvedAt: null }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// 🔥 EFEK DOMINO SETELAH APPROVE: DM user + invite VIP + push FCM + ops feed
async function finalizeApprovedPayment(db, helpers, r) {
  const { sendTG, getTpl, createInviteLink, vipGroupId, pushAll, notifyOps } = helpers;
  try {
    let inviteText = '⚠️ Link invite VIP gagal dibuat otomatis.';
    let inviteMarkup = undefined;
    try {
      const invite = await createInviteLink(vipGroupId, { member_limit: 1 });
      inviteText = '🚪 Ketuk tombol di bawah untuk masuk (link sekali pakai):';
      inviteMarkup = { inline_keyboard: [[{ text: '🚪 MASUK GRUP VIP', url: invite.invite_link }]] };
    } catch (e) { /* abaikan */ }
    const msgText = await getTpl('payment_success', {
      tanggal: r.expiredAt.toLocaleString('id-ID'), token: r.token, invite: inviteText
    });
    await sendTG(r.chatId, msgText, { parse_mode: 'HTML', ...(inviteMarkup ? { reply_markup: inviteMarkup } : {}) });
  } catch (e) { console.error('DM payment success gagal:', e.message); }

  try {
    if (pushAll) await pushAll('💰 Pembayaran GoPay Masuk!', `Rp ${r.amount.toLocaleString('id-ID')} • UID ${r.uid} • approve: ${r.approvedBy}`, 'pay');
  } catch (e) { /* abaikan */ }

  try {
    if (notifyOps) await notifyOps(
      `💰 <b>GoPay APPROVED</b> oleh ${r.approvedBy}\nRp ${r.amount.toLocaleString('id-ID')} • UID <code>${r.uid}</code> • ${r.orderId}`,
      { safe: `💰 GoPay approved ${r.approvedBy} • Rp ${r.amount.toLocaleString('id-ID')}`, type: 'pay' }
    );
  } catch (e) { /* abaikan */ }
}

module.exports = { recordTransaction, activatePaymentUser, approvePendingPayment, finalizeApprovedPayment };