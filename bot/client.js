'use strict';

const { bot, getState, setStep, setData, clearState, safeSend, ack, safeDelete } = require('./core');
const db      = require('../config/db');
const wa      = require('../services/whatsapp');
const pay     = require('../services/payment');
const { formatRupiah, formatNumber } = require('../utils/helper');

// ─── Keyboards ────────────────────────────────────────────────────────────────
function mainMenuKbd() {
  return {
    inline_keyboard: [
      [{ text: '➕ Tambah Bot',  callback_data: 'c:addbot'   }, { text: '📋 Daftar Bot',  callback_data: 'c:listbot' }],
      [{ text: '⏸️ Jeda',        callback_data: 'c:delay'    }, { text: '▶️ Start Blast', callback_data: 'c:start'   }],
      [{ text: '📊 Log',         callback_data: 'c:log'      }, { text: '💸 Withdraw',    callback_data: 'c:withdraw'}],
    ],
  };
}

function backKbd(data) {
  return { inline_keyboard: [[{ text: '◀️ Kembali', callback_data: data }]] };
}

const NOMINAL_LIST = [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000];

// ─── Main Menu ────────────────────────────────────────────────────────────────
async function showMainMenu(chatId, user) {
  await safeSend(chatId,
    `📲 *Panel Client — WA Blast*\n\n` +
    `👤 *${user.full_name || user.username || 'User'}*\n` +
    `💰 Saldo: *${formatRupiah(user.balance)}*\n\n` +
    `Pilih menu:`,
    { reply_markup: mainMenuKbd() }
  );
}

// ─── Tambah Bot ───────────────────────────────────────────────────────────────
async function showAddBot(chatId, tid) {
  setStep(tid, 'c:await_bot_name');
  await safeSend(chatId,
    `➕ *Tambah Akun WhatsApp*\n\n` +
    `Masukkan nama/label untuk akun ini:\n_(Contoh: Akun Promo 1)_`,
    { reply_markup: backKbd('c:main') }
  );
}

// ─── Daftar Bot ───────────────────────────────────────────────────────────────
async function showListBot(chatId, user) {
  const res = await db.query(
    "SELECT * FROM wa_sessions WHERE user_id=$1 ORDER BY id DESC",
    [user.id]
  );

  if (!res.rows.length) {
    return safeSend(chatId,
      '📭 Belum ada akun WA terdaftar.\n\nTambahkan akun pertama Anda melalui menu *➕ Tambah Bot*.',
      { reply_markup: mainMenuKbd() }
    );
  }

  const buttons = [];
  for (const s of res.rows) {
    const icon  = s.status === 'connected' ? '🟢' : s.status === 'banned' ? '🔴' : '🟡';
    const label = `${icon} ${s.session_name} (${s.phone_number || 'belum terhubung'})`;
    buttons.push([{ text: label, callback_data: `c:bot_detail:${s.id}` }]);
  }
  buttons.push([{ text: '◀️ Kembali', callback_data: 'c:main' }]);

  await safeSend(chatId, '📋 *Daftar Akun WhatsApp:*', { reply_markup: { inline_keyboard: buttons } });
}

async function showBotDetail(chatId, sessionId, user) {
  const res = await db.query("SELECT * FROM wa_sessions WHERE id=$1 AND user_id=$2", [sessionId, user.id]);
  if (!res.rows.length) return safeSend(chatId, '❌ Sesi tidak ditemukan.');
  const s    = res.rows[0];
  const icon = s.status === 'connected' ? '🟢 Connected' : s.status === 'banned' ? '🔴 Banned' : '🟡 Disconnected';
  const blastJob = wa.getBlastJob(sessionId);

  await safeSend(chatId,
    `📱 *Detail Akun*\n\n` +
    `🏷️ Nama       : *${s.session_name}*\n` +
    `📞 Nomor      : \`${s.phone_number || '-'}\`\n` +
    `🔌 Status     : *${icon}*\n` +
    `⏱️ Jeda       : *${s.delay_ms} ms*\n` +
    `📨 Terkirim   : *${formatNumber(s.last_msg_index)}*\n` +
    `🔥 Blast      : ${blastJob.running ? '▶️ Berjalan' : '⏹️ Berhenti'}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚪 Log Out Akun', callback_data: `c:logout_confirm:${sessionId}` }],
          [{ text: '◀️ Kembali',      callback_data: 'c:listbot'                      }],
        ],
      },
    }
  );
}

// ─── Jeda (Delay) ─────────────────────────────────────────────────────────────
async function showDelayMenu(chatId, user) {
  const res = await db.query(
    "SELECT id, session_name, delay_ms, status FROM wa_sessions WHERE user_id=$1 ORDER BY id",
    [user.id]
  );

  if (!res.rows.length) {
    return safeSend(chatId, '📭 Belum ada akun WA terdaftar.', { reply_markup: backKbd('c:main') });
  }

  const buttons = res.rows.map(s => {
    const icon = s.status === 'connected' ? '🟢' : '🟡';
    return [{ text: `${icon} ${s.session_name} — ${s.delay_ms}ms`, callback_data: `c:set_delay:${s.id}` }];
  });
  buttons.push([{ text: '◀️ Kembali', callback_data: 'c:main' }]);

  await safeSend(chatId, '⏸️ *Setting Jeda per Akun:*\n\n_Klik akun untuk ubah jeda pengiriman._', { reply_markup: { inline_keyboard: buttons } });
}

// ─── Start Blast ──────────────────────────────────────────────────────────────
async function showStartMenu(chatId, user) {
  const res = await db.query(
    "SELECT id, session_name, status FROM wa_sessions WHERE user_id=$1 AND status='connected' ORDER BY id",
    [user.id]
  );

  if (!res.rows.length) {
    return safeSend(chatId, '❌ Tidak ada akun WA yang aktif.\n\nPastikan akun sudah terhubung di menu *📋 Daftar Bot*.', { reply_markup: backKbd('c:main') });
  }

  const pendingCount = await db.query("SELECT COUNT(*) as cnt FROM targets WHERE status='pending'");
  const totalPending = parseInt(pendingCount.rows[0].cnt);

  if (totalPending === 0) {
    return safeSend(chatId, '⚠️ Tidak ada nomor target pending.\n\nAdmin belum upload target atau semua sudah terkirim.', { reply_markup: backKbd('c:main') });
  }

  const buttons = res.rows.map(s => {
    const job    = wa.getBlastJob(s.id);
    const status = job.running ? '▶️ Running' : '⏹️ Idle';
    return [{ text: `${status} — ${s.session_name}`, callback_data: `c:start_session:${s.id}` }];
  });
  buttons.push([{ text: '⏹️ Stop Semua', callback_data: 'c:stop_all' }]);
  buttons.push([{ text: '◀️ Kembali',    callback_data: 'c:main'     }]);

  await safeSend(chatId,
    `▶️ *Start Blast*\n\n` +
    `🎯 Target pending: *${formatNumber(totalPending)}*\n\n` +
    `_Pilih akun untuk memulai/menghentikan blast:_`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

// ─── Log ─────────────────────────────────────────────────────────────────────
async function showLogMenu(chatId, user) {
  const res = await db.query(
    "SELECT id, session_name FROM wa_sessions WHERE user_id=$1 ORDER BY id",
    [user.id]
  );

  if (!res.rows.length) {
    return safeSend(chatId, '📭 Belum ada akun.', { reply_markup: backKbd('c:main') });
  }

  const buttons = res.rows.map(s => [{ text: `📊 ${s.session_name}`, callback_data: `c:log_session:${s.id}` }]);
  buttons.push([{ text: '◀️ Kembali', callback_data: 'c:main' }]);

  await safeSend(chatId, '📊 *Log Pengiriman — Pilih Akun:*', { reply_markup: { inline_keyboard: buttons } });
}

async function showSessionLog(chatId, sessionId, user) {
  const [sessRes, statsRes, logsRes] = await Promise.all([
    db.query("SELECT session_name FROM wa_sessions WHERE id=$1 AND user_id=$2", [sessionId, user.id]),
    db.query(
      `SELECT
        COUNT(*) FILTER (WHERE status='sent')   as sent,
        COUNT(*) FILTER (WHERE status='failed') as failed,
        COALESCE(SUM(cost),0)                   as total_earn
       FROM send_logs WHERE session_id=$1`,
      [sessionId]
    ),
    db.query(
      "SELECT phone_number, status, cost, sent_at FROM send_logs WHERE session_id=$1 ORDER BY sent_at DESC LIMIT 10",
      [sessionId]
    ),
  ]);

  if (!sessRes.rows.length) return safeSend(chatId, '❌ Sesi tidak ditemukan.');

  const s = statsRes.rows[0];
  let text = `📊 *Log — ${sessRes.rows[0].session_name}*\n\n`;
  text += `✅ Terkirim  : *${formatNumber(s.sent)}*\n`;
  text += `❌ Gagal     : *${formatNumber(s.failed)}*\n`;
  text += `💰 Total Earn: *${formatRupiah(s.total_earn)}*\n\n`;
  text += `📋 *10 Log Terakhir:*\n`;

  for (const l of logsRes.rows) {
    const icon = l.status === 'sent' ? '✅' : '❌';
    const time = new Date(l.sent_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    text += `${icon} \`${l.phone_number}\` — ${time}\n`;
  }

  await safeSend(chatId, text, { reply_markup: backKbd('c:log') });
}

// ─── Withdraw ─────────────────────────────────────────────────────────────────
async function showWithdrawMenu(chatId, user) {
  // Refresh balance
  const uRes  = await db.query("SELECT balance FROM users WHERE id=$1", [user.id]);
  const balance = parseFloat(uRes.rows[0]?.balance || 0);

  await safeSend(chatId,
    `💸 *Menu Withdraw*\n\n💰 Saldo Anda: *${formatRupiah(balance)}*`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Tarik Sekarang', callback_data: 'c:withdraw_start' }],
          [{ text: '👜 Kelola Wallet',  callback_data: 'c:wallet'         }],
          [{ text: '◀️ Kembali',        callback_data: 'c:main'           }],
        ],
      },
    }
  );
}

async function showWithdrawStart(chatId, user) {
  // Check wallet
  const wRes = await db.query("SELECT * FROM wallets WHERE user_id=$1", [user.id]);
  if (!wRes.rows.length) {
    return safeSend(chatId,
      `⚠️ *Wallet belum diatur!*\n\nSilakan atur wallet Anda terlebih dahulu sebelum menarik saldo.`,
      { reply_markup: backKbd('c:withdraw') }
    );
  }

  const uRes     = await db.query("SELECT balance FROM users WHERE id=$1", [user.id]);
  const balance  = parseFloat(uRes.rows[0]?.balance || 0);
  const wallet   = wRes.rows[0];
  const minWd    = 10000;

  if (balance < minWd) {
    return safeSend(chatId,
      `❌ Saldo tidak mencukupi.\n\nMinimal penarikan: *${formatRupiah(minWd)}*\nSaldo Anda: *${formatRupiah(balance)}*`,
      { reply_markup: backKbd('c:withdraw') }
    );
  }

  // Build nominal buttons (only show amounts <= balance)
  const rows = [];
  const available = NOMINAL_LIST.filter(n => n <= balance);
  for (let i = 0; i < available.length; i += 3) {
    rows.push(
      available.slice(i, i + 3).map(n => ({
        text: formatRupiah(n), callback_data: `c:wd_nominal:${n}`
      }))
    );
  }
  rows.push([{ text: '◀️ Kembali', callback_data: 'c:withdraw' }]);

  await safeSend(chatId,
    `💸 *Tarik Saldo*\n\n` +
    `💰 Saldo   : *${formatRupiah(balance)}*\n` +
    `👜 Wallet  : *${wallet.method}* — \`${wallet.account_number}\`\n` +
    `👤 Nama    : *${wallet.account_name}*\n\n` +
    `_Pilih nominal penarikan:_`,
    { reply_markup: { inline_keyboard: rows } }
  );
}

async function showWalletMenu(chatId, user) {
  const res = await db.query("SELECT * FROM wallets WHERE user_id=$1", [user.id]);
  const w   = res.rows[0];

  await safeSend(chatId,
    `👜 *Wallet Saya*\n\n` +
    (w
      ? `💳 Metode : *${w.method}*\n📞 Nomor  : \`${w.account_number}\`\n👤 Nama   : *${w.account_name}*`
      : `⚠️ Wallet belum diatur.`),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: w ? '✏️ Ubah Wallet' : '➕ Tambah Wallet', callback_data: 'c:wallet_set' }],
          [{ text: '◀️ Kembali', callback_data: 'c:withdraw' }],
        ],
      },
    }
  );
}

// ─── Message Handler ──────────────────────────────────────────────────────────
async function handleClientMessage(msg, user) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;
  const state  = getState(tid);
  const text   = msg.text?.trim() || '';

  if (!state.step) return;

  switch (state.step) {

    // ── Add Bot: name ─────────────────────────────────────────────────────────
    case 'c:await_bot_name': {
      if (!text || text.length < 2) return safeSend(chatId, '❌ Nama minimal 2 karakter.');
      setData(tid, { botName: text });
      setStep(tid, 'c:await_bot_phone');
      return safeSend(chatId,
        `✅ Nama: *${text}*\n\n📞 Masukkan nomor HP WhatsApp yang akan di-link:\n_(Format: 08xxx atau 628xxx)_`
      );
    }

    // ── Add Bot: phone → create session + pairing code ────────────────────────
    case 'c:await_bot_phone': {
      const rawPhone = text.replace(/\D/g, '');
      const phone    = rawPhone.startsWith('0') ? '62' + rawPhone.slice(1) : rawPhone;
      if (phone.length < 10 || phone.length > 15) return safeSend(chatId, '❌ Nomor tidak valid.');

      const botName = state.data?.botName || 'Bot Baru';

      // Create DB record
      const sessRes = await db.query(
        "INSERT INTO wa_sessions (user_id, session_name, phone_number) VALUES ($1,$2,$3) RETURNING id",
        [user.id, botName, phone]
      );
      const sessionId = sessRes.rows[0].id;
      clearState(tid);

      const waitMsg = await safeSend(chatId,
        `⏳ *Menghubungkan ke WhatsApp...*\n\n` +
        `Sedang meminta kode pairing untuk nomor \`${phone}\`\n` +
        `Mohon tunggu 10-20 detik...`
      );

      // connectSession will fire pairingCb when QR phase is active (real code)
      await wa.connectSession(sessionId, phone, async (code, err) => {
        await safeDelete(chatId, waitMsg.message_id);

        if (err || !code) {
          // Cleanup DB record on failure
          await db.query("DELETE FROM wa_sessions WHERE id=$1", [sessionId]);
          return safeSend(chatId,
            `❌ *Gagal mendapatkan kode pairing*\n\n` +
            `Alasan: \`${err || 'Unknown error'}\`\n\n` +
            `💡 *Tips:*\n` +
            `• Pastikan nomor HP aktif & terdaftar di WhatsApp\n` +
            `• Format: \`628xxx\` atau \`08xxx\`\n` +
            `• Coba lagi setelah 30 detik`,
            { reply_markup: mainMenuKbd() }
          );
        }

        // code already formatted as XXXX-XXXX by whatsapp.js
        await safeSend(chatId,
          `✅ *Kode Pairing Berhasil!*\n\n` +
          `🔑 \`${code}\`\n\n` +
          `📱 *Cara memasukkan kode:*\n` +
          `1. Buka WhatsApp di HP\n` +
          `2. Ketuk ⋮ → *Perangkat Tertaut*\n` +
          `3. Ketuk *Tautkan Perangkat*\n` +
          `4. Pilih *Tautkan dengan nomor telepon*\n` +
          `5. Masukkan kode di atas\n\n` +
          `⏰ Kode berlaku *60 detik*\n` +
          `_Setelah berhasil, akun otomatis muncul di Daftar Bot._`,
          { reply_markup: mainMenuKbd() }
        );
      });
      break;
    }

    // ── Set Delay ──────────────────────────────────────────────────────────────
    case 'c:await_delay': {
      const sessionId = state.data?.sessionId;
      const ms        = parseInt(text.replace(/\D/g, ''));
      if (isNaN(ms) || ms < 1000) return safeSend(chatId, '❌ Jeda minimal 1000ms (1 detik).');
      await db.query("UPDATE wa_sessions SET delay_ms=$1 WHERE id=$2 AND user_id=$3", [ms, sessionId, user.id]);
      clearState(tid);
      return safeSend(chatId, `✅ Jeda diset ke *${ms}ms* (${(ms/1000).toFixed(1)} detik).`, { reply_markup: backKbd('c:delay') });
    }

    // ── Wallet: account number ─────────────────────────────────────────────────
    case 'c:await_wallet_number': {
      const number = text.replace(/\D/g, '');
      if (number.length < 8) return safeSend(chatId, '❌ Nomor tidak valid.');
      setData(tid, { walletNumber: number });
      setStep(tid, 'c:await_wallet_name');
      return safeSend(chatId, '👤 Masukkan nama pemilik akun dompet:');
    }

    // ── Wallet: account name → save ───────────────────────────────────────────
    case 'c:await_wallet_name': {
      const { walletMethod, walletNumber } = state.data || {};
      if (!walletMethod || !walletNumber) {
        clearState(tid);
        return safeSend(chatId, '❌ Terjadi kesalahan. Ulangi dari menu Wallet.');
      }

      const name = text;
      await db.query(
        `INSERT INTO wallets (user_id, method, account_number, account_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id) DO UPDATE SET method=$2, account_number=$3, account_name=$4, updated_at=NOW()`,
        [user.id, walletMethod, walletNumber, name]
      );
      clearState(tid);
      return safeSend(chatId,
        `✅ *Wallet Tersimpan!*\n\n💳 *${walletMethod}*\n📞 \`${walletNumber}\`\n👤 ${name}`,
        { reply_markup: backKbd('c:wallet') }
      );
    }

    default:
      break;
  }
}

// ─── Callback Handler ─────────────────────────────────────────────────────────
async function handleClientCallback(query, user) {
  const chatId = query.message.chat.id;
  const tid    = query.from.id;
  const data   = query.data;

  await ack(query.id);

  // ── Main menu ────────────────────────────────────────────────────────────────
  if (data === 'c:main') return showMainMenu(chatId, user);

  // ── Add bot ──────────────────────────────────────────────────────────────────
  if (data === 'c:addbot') return showAddBot(chatId, tid);

  // ── List bot ─────────────────────────────────────────────────────────────────
  if (data === 'c:listbot') return showListBot(chatId, user);
  if (data.startsWith('c:bot_detail:')) {
    const sid = parseInt(data.split(':')[2]);
    return showBotDetail(chatId, sid, user);
  }
  if (data.startsWith('c:logout_confirm:')) {
    const sid = parseInt(data.split(':')[2]);
    return safeSend(chatId, '⚠️ Yakin ingin logout akun ini? Semua blast akan dihentikan.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Ya, Logout', callback_data: `c:logout_exec:${sid}` }, { text: '❌ Batal', callback_data: `c:bot_detail:${sid}` }],
          ],
        },
      }
    );
  }
  if (data.startsWith('c:logout_exec:')) {
    const sid = parseInt(data.split(':')[2]);
    // Verify ownership
    const r = await db.query("SELECT id FROM wa_sessions WHERE id=$1 AND user_id=$2", [sid, user.id]);
    if (!r.rows.length) return safeSend(chatId, '❌ Akun tidak ditemukan.');
    await wa.logoutSession(sid);
    await db.query("DELETE FROM wa_sessions WHERE id=$1", [sid]);
    return safeSend(chatId, '✅ Akun berhasil di-logout dan dihapus.', { reply_markup: mainMenuKbd() });
  }

  // ── Delay ────────────────────────────────────────────────────────────────────
  if (data === 'c:delay') return showDelayMenu(chatId, user);
  if (data.startsWith('c:set_delay:')) {
    const sid = parseInt(data.split(':')[2]);
    setStep(tid, 'c:await_delay');
    setData(tid, { sessionId: sid });
    return safeSend(chatId, `⏸️ Masukkan jeda baru dalam *milidetik* (minimal 1000):\nContoh: \`3000\` = 3 detik`);
  }

  // ── Start ────────────────────────────────────────────────────────────────────
  if (data === 'c:start') return showStartMenu(chatId, user);
  if (data.startsWith('c:start_session:')) {
    const sid = parseInt(data.split(':')[2]);
    const job = wa.getBlastJob(sid);

    if (job.running) {
      // Already running → offer stop
      wa.stopBlast(sid);
      return safeSend(chatId, `⏹️ Blast dihentikan.`, { reply_markup: backKbd('c:start') });
    }

    // Check ownership
    const r = await db.query("SELECT id FROM wa_sessions WHERE id=$1 AND user_id=$2", [sid, user.id]);
    if (!r.rows.length) return safeSend(chatId, '❌ Akun tidak ditemukan.');

    const startMsg = await safeSend(chatId, '▶️ Memulai blast...');

    const result = await wa.startBlast(sid, async (event) => {
      // Handle blast events
      if (event.type === 'progress' && event.sentCount % 10 === 0) {
        // Update every 10 messages sent
        try {
          await bot.editMessageText(
            `▶️ *Blast Berjalan*\n\n` +
            `✅ Terkirim: *${formatNumber(event.sentCount)}*\n` +
            `❌ Gagal   : *${formatNumber(event.failCount)}*\n` +
            `📞 Terakhir: \`${event.phone}\``,
            { chat_id: chatId, message_id: startMsg.message_id, parse_mode: 'Markdown' }
          );
        } catch (_) {}
      }
      if (event.type === 'done') {
        try { await safeDelete(chatId, startMsg.message_id); } catch (_) {}
        await safeSend(chatId,
          `✅ *Blast Selesai!*\n\n✅ Terkirim: *${formatNumber(event.sentCount)}*\n❌ Gagal: *${formatNumber(event.failCount)}*`,
          { reply_markup: mainMenuKbd() }
        );
      }
      if (event.type === 'stopped' || event.type === 'error') {
        try { await safeDelete(chatId, startMsg.message_id); } catch (_) {}
        await safeSend(chatId,
          `⏹️ *Blast Dihentikan*\n\n` +
          `📌 Alasan: ${event.reason || event.message || 'Manual stop'}\n` +
          `📞 Nomor Terakhir: \`${event.lastPhone || '-'}\`\n` +
          `✅ Terkirim: *${formatNumber(event.sentCount || 0)}*`,
          { reply_markup: mainMenuKbd() }
        );
      }
      if (event.type === 'banned') {
        await safeSend(chatId, `🚫 *Akun Di-BAN oleh WhatsApp!*\n\nBlast otomatis dihentikan. Silakan tambah akun baru.`, { reply_markup: mainMenuKbd() });
      }
      if (event.type === 'disconnected') {
        await safeSend(chatId, `🔌 *Akun Terputus!*\n\nBlast dihentikan. Cek koneksi akun di *📋 Daftar Bot*.`, { reply_markup: mainMenuKbd() });
      }
    });

    if (!result.success) {
      try { await safeDelete(chatId, startMsg.message_id); } catch (_) {}
      return safeSend(chatId, `❌ ${result.message}`, { reply_markup: backKbd('c:start') });
    }

    return;
  }

  if (data === 'c:stop_all') {
    const res = await db.query("SELECT id FROM wa_sessions WHERE user_id=$1", [user.id]);
    for (const r of res.rows) wa.stopBlast(r.id);
    return safeSend(chatId, '⏹️ Semua blast dihentikan.', { reply_markup: mainMenuKbd() });
  }

  // ── Log ──────────────────────────────────────────────────────────────────────
  if (data === 'c:log') return showLogMenu(chatId, user);
  if (data.startsWith('c:log_session:')) {
    const sid = parseInt(data.split(':')[2]);
    return showSessionLog(chatId, sid, user);
  }

  // ── Withdraw ─────────────────────────────────────────────────────────────────
  if (data === 'c:withdraw')        return showWithdrawMenu(chatId, user);
  if (data === 'c:withdraw_start')  return showWithdrawStart(chatId, user);
  if (data === 'c:wallet')          return showWalletMenu(chatId, user);

  if (data === 'c:wallet_set') {
    // Show method selector
    const methods = pay.WALLET_METHODS.map(m => [{ text: `💳 ${m}`, callback_data: `c:wallet_method:${m}` }]);
    methods.push([{ text: '◀️ Kembali', callback_data: 'c:wallet' }]);
    return safeSend(chatId, '💳 Pilih metode dompet digital:', { reply_markup: { inline_keyboard: methods } });
  }

  if (data.startsWith('c:wallet_method:')) {
    const method = data.replace('c:wallet_method:', '');
    setStep(tid, 'c:await_wallet_number');
    setData(tid, { walletMethod: method });
    return safeSend(chatId, `💳 *${method}* dipilih.\n\n📞 Masukkan nomor ${method} Anda:`);
  }

  // ── Withdraw nominal ─────────────────────────────────────────────────────────
  if (data.startsWith('c:wd_nominal:')) {
    const amount   = parseInt(data.split(':')[2]);
    const wRes     = await db.query("SELECT * FROM wallets WHERE user_id=$1", [user.id]);
    const wallet   = wRes.rows[0];
    if (!wallet) return safeSend(chatId, '❌ Wallet belum diatur.', { reply_markup: backKbd('c:withdraw') });

    const uRes    = await db.query("SELECT balance FROM users WHERE id=$1", [user.id]);
    const balance = parseFloat(uRes.rows[0]?.balance || 0);
    if (balance < amount) return safeSend(chatId, `❌ Saldo tidak cukup. Saldo: *${formatRupiah(balance)}*`, { reply_markup: backKbd('c:withdraw') });

    return safeSend(chatId,
      `💸 *Konfirmasi Penarikan*\n\n` +
      `💰 Nominal  : *${formatRupiah(amount)}*\n` +
      `💳 Metode   : *${wallet.method}*\n` +
      `📞 Nomor    : \`${wallet.account_number}\`\n` +
      `👤 Nama     : *${wallet.account_name}*\n\n` +
      `Lanjutkan penarikan?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Submit', callback_data: `c:wd_submit:${amount}` }, { text: '❌ Batal', callback_data: 'c:withdraw' }],
          ],
        },
      }
    );
  }

  // ── Execute withdraw ──────────────────────────────────────────────────────────
  if (data.startsWith('c:wd_submit:')) {
    const amount  = parseInt(data.split(':')[2]);
    const wRes    = await db.query("SELECT * FROM wallets WHERE user_id=$1", [user.id]);
    const wallet  = wRes.rows[0];
    if (!wallet) return safeSend(chatId, '❌ Wallet belum diatur.');

    // Check + reserve balance atomically
    const deductRes = await db.query(
      "UPDATE users SET balance = balance - $1 WHERE id=$2 AND balance >= $1 RETURNING id",
      [amount, user.id]
    );
    if (!deductRes.rows.length) {
      return safeSend(chatId, '❌ Saldo tidak mencukupi.', { reply_markup: backKbd('c:withdraw') });
    }

    const wd = await db.query(
      "INSERT INTO withdrawals (user_id, amount, method, account_number, account_name) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [user.id, amount, wallet.method, wallet.account_number, wallet.account_name]
    );
    const wdId = wd.rows[0].id;

    const waitMsg = await safeSend(chatId, '⏳ Memproses penarikan...');

    // Call Duitku disbursement
    const bankCode  = pay.WALLET_CODES[wallet.method] || wallet.method.toUpperCase();
    const result    = await pay.createDisbursement({
      amount,
      bankCode,
      accountNumber: wallet.account_number,
      accountName:   wallet.account_name,
      description:   `Penarikan WA Blast #${wdId}`,
    });

    await safeDelete(chatId, waitMsg.message_id);

    if (result.success) {
      await db.query(
        "UPDATE withdrawals SET status='processing', duitku_ref=$1, updated_at=NOW() WHERE id=$2",
        [result.disburseId, wdId]
      );
      await safeSend(chatId,
        `✅ *Penarikan Berhasil Diproses!*\n\n` +
        `💰 Nominal  : *${formatRupiah(amount)}*\n` +
        `💳 Metode   : *${wallet.method}*\n` +
        `📞 Nomor    : \`${wallet.account_number}\`\n` +
        `🔖 Ref ID   : \`${result.disburseId}\`\n\n` +
        `⏰ Dana akan masuk dalam *5-15 menit*.`,
        { reply_markup: mainMenuKbd() }
      );
    } else {
      // Refund balance
      await db.query("UPDATE users SET balance = balance + $1 WHERE id=$2", [amount, user.id]);
      await db.query("UPDATE withdrawals SET status='failed', note=$1 WHERE id=$2", [result.error, wdId]);
      await safeSend(chatId,
        `❌ *Penarikan Gagal!*\n\n${result.error || 'Coba beberapa saat lagi.'}\n\nSaldo Anda telah dikembalikan.`,
        { reply_markup: backKbd('c:withdraw') }
      );
    }

    return;
  }
}

module.exports = { showMainMenu, handleClientMessage, handleClientCallback };
