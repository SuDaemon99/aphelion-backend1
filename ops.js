const runReminders = async () => {
  const db = getFirestore();
  const now = new Date();
  const soon = new Date(now.getTime() + 4 * 86400000);
  const snap = await db.collection('users')
    .where('status', '==', 'ACTIVE')
    .where('expiredAt', '>', now)
    .where('expiredAt', '<', soon)
    .get();
  let sent = 0;
  for (const doc of snap.docs) {
    const u = doc.data();
    const chatDoc = await db.collection('telegram_chats').doc(doc.id).get();
    if (!chatDoc.exists && (u.source === 'manual' || u.source === 'license')) continue; // user lisensi tanpa chat bot → skip reminder
    const daysLeft = Math.ceil((u.expiredAt.toDate() - now) / 86400000);
    const dateStr = u.expiredAt.toDate().toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const chatId = chatDoc.exists ? chatDoc.data().chatId : doc.id;
    try {
      if (daysLeft === 3 && !u.remindedH3) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, parse_mode: 'HTML', text: await getTpl('reminder_h3', { tanggal: dateStr }) });
        await db.collection('users').doc(doc.id).update({ remindedH3: true });
        sent++;
      } else if (daysLeft === 1 && !u.remindedH1) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, parse_mode: 'HTML', text: await getTpl('reminder_h1', { tanggal: dateStr }) });
        await db.collection('users').doc(doc.id).update({ remindedH1: true });
        sent++;
      }
    } catch (e) { console.error('Reminder gagal:', e.message); }
  }
  return sent;
};
