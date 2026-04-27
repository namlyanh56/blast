'use strict';

const { bot, ADMIN_ID, getOrRegisterUser, safeSend, clearState } = require('./core');
const admin  = require('./admin');
const client = require('./client');

// ─── /start command ──────────────────────────────────────────────────────────
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

// ─── /menu command ───────────────────────────────────────────────────────────
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

// ─── /cancel command ─────────────────────────────────────────────────────────
bot.onText(/\/cancel/, async (msg) => {
  const user = await getOrRegisterUser(msg.from);
  clearState(msg.from.id);
  await safeSend(msg.chat.id, '❌ Operasi dibatalkan.', {
    reply_markup: {
      inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: user.role === 'admin' ? 'a:main' : 'c:main' }]],
    },
  });
});

// ─── /status command (admin only) ────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const db = require('../config/db');
  const wa = require('../services/whatsapp');

  const [conns, pending, users] = await Promise.all([
    db.query("SELECT COUNT(*) as cnt FROM wa_sessions WHERE status='connected'"),
    db.query("SELECT COUNT(*) as cnt FROM targets WHERE status='pending'"),
    db.query("SELECT COUNT(*) as cnt FROM users WHERE role='client'"),
  ]);

  const activeSessions = wa.getAllSessions();
  const runningBlasts  = [...activeSessions.keys()].length;

  await safeSend(msg.chat.id,
    `📊 *System Status*\n\n` +
    `📱 WA Connected : *${conns.rows[0].cnt}*\n` +
    `🔥 Active Blasts: *${runningBlasts}*\n` +
    `🎯 Pending Targets: *${pending.rows[0].cnt}*\n` +
    `👥 Total Clients: *${users.rows[0].cnt}*\n\n` +
    `⏰ ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
  );
});

// ─── All messages ─────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  // Skip commands (handled above)
  if (msg.text?.startsWith('/')) return;

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

    if (data === 'c:main' && user.role === 'admin') {
      // Refresh user data (balance may have changed)
      return await admin.showMainMenu(query.message.chat.id);
    }

    if (data === 'a:main' && user.role !== 'admin') {
      return await safeSend(query.message.chat.id, '⛔ Akses ditolak.');
    }

    if (user.role === 'admin') {
      // Admin handles both a: and some c: for viewing
      if (data.startsWith('a:')) {
        await admin.handleAdminCallback(query, user);
      } else {
        // Admin can also use /start-like client callbacks if needed
        await safeSend(query.message.chat.id, '⚠️ Gunakan /menu untuk kembali ke menu admin.');
      }
    } else {
      if (data.startsWith('c:')) {
        // Re-fetch user to get latest balance
        const db   = require('../config/db');
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
    console.error('❌ Conflict: Another bot instance is running!');
    process.exit(1);
  }
  console.error('⚠️  Polling error:', err.message);
});

module.exports = bot;
