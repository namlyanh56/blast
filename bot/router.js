'use strict';

/**
 * bot/router.js
 *
 * FIX 1: listener bot.on('message') sekarang menangkap msg.photo agar
 *         foto yang dikirim langsung dari Telegram bisa diproses oleh
 *         handleAdminMessage / handleClientMessage tanpa URL.
 */

const { bot, ADMIN_ID, getOrRegisterUser, safeSend, clearState } = require('./core');
const admin  = require('./admin');
const client = require('./client');

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  try {
    const user = await getOrRegisterUser(msg.from);
    if (user.role === 'admin') {
      await admin.showMainMenu(msg.chat.id);
    } else {
      await client.showMainMenu(msg.chat.id, user);
    }
  } catch (err) {
    console.error('❌ /start error:', err.message);
  }
});

// ─── /menu ────────────────────────────────────────────────────────────────────
bot.onText(/\/menu/, async (msg) => {
  try {
    const user = await getOrRegisterUser(msg.from);
    if (user.role === 'admin') {
      await admin.showMainMenu(msg.chat.id);
    } else {
      await client.showMainMenu(msg.chat.id, user);
    }
  } catch (err) {
    console.error('❌ /menu error:', err.message);
  }
});

// ─── /cancel ──────────────────────────────────────────────────────────────────
bot.onText(/\/cancel/, async (msg) => {
  const user = await getOrRegisterUser(msg.from);
  clearState(msg.from.id);
  await safeSend(msg.chat.id, '❌ Operasi dibatalkan.', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🏠 Menu Utama', callback_data: user.role === 'admin' ? 'a:main' : 'c:main' },
      ]],
    },
  });
});

// ─── /status (admin only) ─────────────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = require('../config/db');
  const wa = require('../services/whatsapp');

  const [conns, pending, users] = await Promise.all([
    db.query("SELECT COUNT(*) as cnt FROM wa_sessions WHERE status='connected'"),
    db.query("SELECT COUNT(*) as cnt FROM targets WHERE status='pending'"),
    db.query("SELECT COUNT(*) as cnt FROM users WHERE role='client'"),
  ]);

  await safeSend(msg.chat.id,
    `📊 *System Status*\n\n` +
    `📱 WA Connected   : *${conns.rows[0].cnt}*\n` +
    `🎯 Pending Targets: *${pending.rows[0].cnt}*\n` +
    `👥 Total Clients  : *${users.rows[0].cnt}*\n\n` +
    `⏰ ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
  );
});

// ─── Semua pesan masuk: teks + foto + dokumen ─────────────────────────────────
// FIX 1: Tangkap msg.photo sehingga foto langsung dari Telegram bisa diproses
//         oleh admin/client handler (setting gambar & foto profil tanpa URL).
bot.on('message', async (msg) => {
  // Lewati semua perintah (sudah ditangani di atas)
  if (msg.text?.startsWith('/')) return;

  // Hanya proses teks, foto, atau dokumen
  const hasContent = msg.text || msg.photo || msg.document;
  if (!hasContent) return;

  try {
    const user = await getOrRegisterUser(msg.from);
    if (user.role === 'admin') {
      await admin.handleAdminMessage(msg, user);
    } else {
      await client.handleClientMessage(msg, user);
    }
  } catch (err) {
    console.error('❌ message handler error:', err.message);
    await safeSend(msg.chat.id, `❌ Terjadi kesalahan: ${err.message}`);
  }
});

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  try {
    const user = await getOrRegisterUser(query.from);
    const data = query.data;

    // Blokir akses silang admin ↔ client
    if (data.startsWith('a:') && user.role !== 'admin') {
      return await safeSend(query.message.chat.id, '⛔ Akses ditolak.');
    }

    if (user.role === 'admin') {
      if (data.startsWith('a:')) {
        await admin.handleAdminCallback(query, user);
      } else {
        await safeSend(query.message.chat.id, '⚠️ Gunakan /menu untuk kembali ke panel admin.');
      }
    } else {
      if (data.startsWith('c:')) {
        // Refresh user agar balance selalu terkini
        const db    = require('../config/db');
        const fresh = await db.query('SELECT * FROM users WHERE telegram_id=$1', [query.from.id]);
        await client.handleClientCallback(query, fresh.rows[0] || user);
      } else {
        await safeSend(query.message.chat.id, '⛔ Akses ditolak.');
      }
    }
  } catch (err) {
    console.error('❌ callback_query error:', err.message);
    try {
      await bot.answerCallbackQuery(query.id, { text: '❌ Error: ' + err.message.slice(0, 60) });
    } catch (_) {}
  }
});

// ─── Polling error handler ────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
    console.error('❌ Conflict: Ada instance bot lain yang berjalan! Matikan dulu.');
    process.exit(1);
  }
  console.error('⚠️  Polling error:', err.message);
});

module.exports = bot;
