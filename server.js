'use strict';

const express = require('express');
const db      = require('../config/db');
const { safeSend } = require('../bot/core');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'WA Blast System',
    time: new Date().toISOString(),
  });
});

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ─── Duitku Disbursement Callback ─────────────────────────────────────────────
/**
 * Duitku will POST to this endpoint when disbursement status changes.
 * Configure this URL in Duitku dashboard:
 *   https://your-vps-ip:3000/api/duitku/callback
 */
app.post('/api/duitku/callback', async (req, res) => {
  try {
    const { disburseId, responseCode, responseMessage } = req.body;

    if (!disburseId) return res.status(400).json({ message: 'Missing disburseId' });

    const wd = await db.query(
      "SELECT * FROM withdrawals WHERE duitku_ref=$1",
      [disburseId]
    );

    if (!wd.rows.length) return res.status(404).json({ message: 'Withdrawal not found' });

    const withdrawal = wd.rows[0];

    if (withdrawal.status === 'success') {
      // Already processed
      return res.status(200).json({ message: 'Already processed' });
    }

    const isSuccess = responseCode === '00';
    const newStatus = isSuccess ? 'success' : 'failed';

    await db.query(
      "UPDATE withdrawals SET status=$1, note=$2, updated_at=NOW() WHERE duitku_ref=$3",
      [newStatus, responseMessage || '', disburseId]
    );

    // Notify user via Telegram
    const userRes = await db.query("SELECT telegram_id FROM users WHERE id=$1", [withdrawal.user_id]);
    const telegramId = userRes.rows[0]?.telegram_id;

    if (telegramId) {
      if (isSuccess) {
        await safeSend(telegramId,
          `✅ *Transfer Berhasil!*\n\n` +
          `💰 Nominal: *Rp ${Number(withdrawal.amount).toLocaleString('id-ID')}*\n` +
          `💳 Metode : *${withdrawal.method}*\n` +
          `📞 Nomor  : \`${withdrawal.account_number}\`\n` +
          `🔖 Ref    : \`${disburseId}\`\n\n` +
          `Dana telah dikirim ke akun Anda.`
        );
      } else {
        // Refund balance on failure
        await db.query("UPDATE users SET balance = balance + $1 WHERE id=$2", [withdrawal.amount, withdrawal.user_id]);
        await safeSend(telegramId,
          `❌ *Transfer Gagal!*\n\n` +
          `Penarikan sebesar *Rp ${Number(withdrawal.amount).toLocaleString('id-ID')}* gagal diproses.\n` +
          `Alasan: ${responseMessage || 'Unknown'}\n\n` +
          `💰 Saldo Anda telah dikembalikan.`
        );
      }
    }

    res.status(200).json({ message: 'Callback processed' });
  } catch (err) {
    console.error('❌ Duitku callback error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── Admin API: real-time target stats (polling-friendly) ─────────────────────
app.get('/api/targets/stats', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        COUNT(*)                                 AS total,
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='sent')    AS sent,
        COUNT(*) FILTER (WHERE status='failed')  AS failed
      FROM targets
    `);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
function startServer() {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🌐 API server running on port ${PORT}`);
    console.log(`📡 Duitku callback URL: http://YOUR_VPS_IP:${PORT}/api/duitku/callback`);
  });
}

module.exports = { app, startServer };
