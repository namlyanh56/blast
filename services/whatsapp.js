'use strict';

/**
 * services/whatsapp.js
 *
 * Perbaikan utama (FIX 2):
 *   requestPairingCode dipanggil LANGSUNG setelah makeWASocket dengan pengecekan
 *   !sock.authState.creds.registered — BUKAN di dalam connection.update.
 *   Ini pola resmi yang direkomendasikan dokumentasi Baileys terbaru.
 *
 * FIX 3: _applyProfileSettings dipanggil tiap kali sesi baru berhasil 'open',
 *   agar setting nama & foto profil dari admin langsung diterapkan otomatis.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

const pino   = require('pino');
const path   = require('path');
const fs     = require('fs');
const axios  = require('axios');

const db     = require('../config/db');
const { htmlToWa, normalizePhone, sleep, randomDelay } = require('../utils/helper');

require('dotenv').config();

// ─── In-memory stores ──────────────────────────────────────────────────────────
const sessions       = new Map(); // sessionId → WASocket
const blastJobs      = new Map(); // sessionId → { running, abort, sentCount, failCount }
const blastCallbacks = new Map(); // sessionId → Function

const SESSION_DIR = process.env.SESSION_DIR || './sessions';
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

// ─── Helpers ───────────────────────────────────────────────────────────────────
function sessionPath(sid) {
  return path.join(SESSION_DIR, `sess_${sid}`);
}

function notify(sid, data) {
  const cb = blastCallbacks.get(sid);
  if (cb) cb(data);
}

function _cleanSessionFiles(sid) {
  const p = sessionPath(sid);
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {}
}

// ─── Apply profile settings (nama + foto) ke sesi yang baru connect ───────────
// FIX 3: Dibaca dari tabel settings dan diterapkan langsung ke socket.
async function _applyProfileSettings(sid, sock) {
  try {
    const res = await db.query(
      "SELECT key, value FROM settings WHERE key IN ('profile_name', 'profile_pic')"
    );
    const st = {};
    for (const r of res.rows) st[r.key] = r.value;

    if (st.profile_name?.trim()) {
      try {
        await sock.updateProfileName(st.profile_name.trim());
        console.log(`[${sid}] ✅ Profile name applied: ${st.profile_name.trim()}`);
      } catch (e) {
        console.error(`[${sid}] Profile name error:`, e.message);
      }
    }

    if (st.profile_pic?.trim()) {
      try {
        const imgRes = await axios.get(st.profile_pic.trim(), {
          responseType: 'arraybuffer',
          timeout: 15000,
        });
        await sock.updateProfilePicture(sock.user.id, Buffer.from(imgRes.data));
        console.log(`[${sid}] ✅ Profile pic applied`);
      } catch (e) {
        console.error(`[${sid}] Profile pic error:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[${sid}] _applyProfileSettings error:`, e.message);
  }
}

// ─── connectSession ────────────────────────────────────────────────────────────
/**
 * Membuat/menghubungkan sesi WhatsApp menggunakan Baileys.
 *
 * FIX 2 — Pairing code yang benar:
 *   Sesuai dokumentasi resmi Baileys & pola komunitas terbaru 2025-2026:
 *   - requestPairingCode dipanggil LANGSUNG setelah makeWASocket
 *   - Pengecekan dilakukan via !sock.authState.creds.registered
 *   - TIDAK menunggu event connection.update
 *   - Format nomor E.164 tanpa '+' (628xxxxxxxxx)
 *
 * @param {number}   sessionId
 * @param {string}   [phoneNumber] - Diperlukan untuk pairing code flow
 * @param {Function} [pairingCb]   - Dipanggil dengan (code, errMsg)
 *                                   code = string kode format XXXX-XXXX, atau null jika error
 *                                   errMsg = string pesan error, atau null jika sukses
 */
async function connectSession(sessionId, phoneNumber = null, pairingCb = null) {
  // Jangan buat duplikat sesi
  if (sessions.has(sessionId)) return;

  await db.query("UPDATE wa_sessions SET status='connecting' WHERE id=$1", [sessionId]);

  const authPath = sessionPath(sessionId);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

  // Load auth state dari file
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version }          = await fetchLatestBaileysVersion();

  // Normalisasi nomor: hapus non-digit, ganti awalan 0 → 62
  const cleanPhone = phoneNumber
    ? String(phoneNumber).replace(/\D/g, '').replace(/^0/, '62')
    : null;

  // ── Buat socket Baileys ──────────────────────────────────────────────────────
  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser:                      Browsers.ubuntu('Chrome'),
    printQRInTerminal:            false, // QR tidak dipakai, kita pakai pairing code
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs:        60_000,
    syncFullHistory:              false,
    markOnlineOnConnect:          false,
  });

  sessions.set(sessionId, sock);
  sock.ev.on('creds.update', saveCreds);

  // ── FIX 2: Request pairing code segera setelah socket dibuat ─────────────────
  // Pola resmi: cek sock.authState.creds.registered LANGSUNG, tanpa menunggu event.
  // Ini mencegah kode palsu/garbage yang terjadi ketika request terlalu dini atau
  // terlambat (di dalam event connection.update).
  if (cleanPhone && pairingCb && !sock.authState.creds.registered) {
    // Berikan waktu singkat agar WebSocket handshake selesai sebelum request kode.
    // Delay 1.5 detik sudah cukup; terlalu lama = QR muncul duluan & mengganggu.
    setTimeout(async () => {
      try {
        // Jika sesi sudah punya creds (reconnect), lewati
        if (sock.authState.creds.registered) {
          return;
        }

        console.log(`[${sessionId}] Requesting pairing code for ${cleanPhone}...`);
        const rawCode = await sock.requestPairingCode(cleanPhone);

        if (!rawCode) throw new Error('Kode kosong, coba ulangi.');

        // Format menjadi XXXX-XXXX agar mudah dibaca user
        const formattedCode = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
        console.log(`[${sessionId}] Pairing code: ${formattedCode}`);

        pairingCb(formattedCode, null);
      } catch (err) {
        console.error(`[${sessionId}] requestPairingCode FAILED:`, err.message);
        pairingCb(null, err.message);
        // Bersihkan sesi yang gagal pairing
        sessions.delete(sessionId);
        await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
        _cleanSessionFiles(sessionId);
      }
    }, 1500);
  }

  // ── Event: connection.update ─────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || '';
      await db.query(
        "UPDATE wa_sessions SET status='connected', phone_number=$1, last_connected=NOW() WHERE id=$2",
        [phone, sessionId]
      );
      console.log(`✅ [${sessionId}] Connected — ${phone}`);

      // FIX 3: Terapkan profile settings dari admin secara otomatis
      await _applyProfileSettings(sessionId, sock);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      sessions.delete(sessionId);
      console.log(`⚠️  [${sessionId}] Closed. Code: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
        _cleanSessionFiles(sessionId);
        notify(sessionId, { type: 'logout', sessionId });
      } else if (statusCode === 403) {
        await db.query("UPDATE wa_sessions SET status='banned' WHERE id=$1", [sessionId]);
        _stopBlastInternal(sessionId, '🚫 Akun di-ban WhatsApp');
        notify(sessionId, { type: 'banned', sessionId });
      } else {
        // Putus karena alasan lain (internet, timeout) → auto reconnect
        await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
        _stopBlastInternal(sessionId, '🔌 Koneksi terputus');
        notify(sessionId, { type: 'disconnected', sessionId });
        setTimeout(() => connectSession(sessionId), 8000);
      }
    }
  });
}

// ─── Send Message ──────────────────────────────────────────────────────────────
async function sendMessage(sessionId, phoneJid, { text, imageUrl, buttonName, buttonUrl }) {
  const sock = sessions.get(sessionId);
  if (!sock) return false;

  try {
    let result = null;

    if (imageUrl?.trim()) {
      try {
        result = await sock.sendMessage(phoneJid, {
          image:      { url: imageUrl },
          caption:    text,
          buttons:    [{ buttonId: 'btn_link', buttonText: { displayText: buttonName }, type: 1 }],
          footer:     buttonUrl,
          headerType: 4,
        });
      } catch {
        // Fallback: kirim tanpa button
        result = await sock.sendMessage(phoneJid, {
          image:   { url: imageUrl },
          caption: `${text}\n\n🔗 *${buttonName}*\n${buttonUrl}`,
        });
      }
    } else {
      try {
        result = await sock.sendMessage(phoneJid, {
          text,
          buttons: [{ buttonId: 'btn_link', buttonText: { displayText: buttonName }, type: 1 }],
          footer:  buttonUrl,
        });
      } catch {
        result = await sock.sendMessage(phoneJid, {
          text: `${text}\n\n🔗 *${buttonName}*: ${buttonUrl}`,
        });
      }
    }

    return !!result;
  } catch (err) {
    console.error(`❌ Send error → ${phoneJid}: ${err.message}`);
    return false;
  }
}

// ─── Start Blast ───────────────────────────────────────────────────────────────
async function startBlast(sessionId, eventCallback) {
  if (blastJobs.get(sessionId)?.running) {
    return { success: false, message: 'Blast sudah berjalan untuk akun ini.' };
  }

  const sock = sessions.get(sessionId);
  if (!sock) return { success: false, message: 'Akun tidak terhubung ke WhatsApp.' };

  const sessRes = await db.query(
    `SELECT s.*, u.id as uid FROM wa_sessions s
     JOIN users u ON s.user_id = u.id WHERE s.id=$1`,
    [sessionId]
  );
  if (!sessRes.rows.length) return { success: false, message: 'Sesi tidak ditemukan.' };
  const sess = sessRes.rows[0];

  // Baca semua settings sekali
  const stRes = await db.query('SELECT key, value FROM settings');
  const st    = {};
  for (const r of stRes.rows) st[r.key] = r.value;

  const price      = parseFloat(st.price_per_message || '100');
  const msgText    = htmlToWa(st.message_text || '');
  const imageUrl   = st.message_image  || '';
  const buttonName = st.button_name    || 'Kunjungi';
  const buttonUrl  = st.button_url     || 'https://example.com';
  const delay      = sess.delay_ms     || 3000;

  const job = { running: true, abort: false, sentCount: 0, failCount: 0 };
  blastJobs.set(sessionId, job);
  blastCallbacks.set(sessionId, eventCallback);

  const runLoop = async () => {
    let lastPhone = '';

    while (!job.abort) {
      // Cek status akun setiap iterasi
      const statusRow = await db.query('SELECT status FROM wa_sessions WHERE id=$1', [sessionId]);
      const curStatus = statusRow.rows[0]?.status;
      if (curStatus !== 'connected') {
        eventCallback({
          type:      'stopped',
          reason:    curStatus === 'banned' ? '🚫 Akun di-ban' : '🔌 Akun terputus',
          lastPhone,
          sentCount: job.sentCount,
          failCount: job.failCount,
        });
        break;
      }

      // Ambil satu target pending secara atomic (safe untuk multi-instance)
      const targetRes = await db.query(
        `UPDATE targets SET status='sending'
         WHERE id = (
           SELECT id FROM targets WHERE status='pending'
           ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, phone_number`
      );

      if (!targetRes.rows.length) {
        eventCallback({ type: 'done', sentCount: job.sentCount, failCount: job.failCount });
        break;
      }

      const target   = targetRes.rows[0];
      const phoneJid = normalizePhone(target.phone_number);
      lastPhone      = target.phone_number;

      const ok = await sendMessage(sessionId, phoneJid, { text: msgText, imageUrl, buttonName, buttonUrl });

      if (ok) {
        await db.query(
          "UPDATE targets SET status='sent', sent_at=NOW(), sent_by_session=$1 WHERE id=$2",
          [sessionId, target.id]
        );
        await db.query(
          'INSERT INTO send_logs (session_id, user_id, phone_number, status, cost) VALUES ($1,$2,$3,$4,$5)',
          [sessionId, sess.uid, target.phone_number, 'sent', price]
        );
        await db.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [price, sess.uid]);
        await db.query('UPDATE wa_sessions SET last_msg_index = last_msg_index + 1 WHERE id=$1', [sessionId]);
        job.sentCount++;
        eventCallback({
          type: 'progress',
          phone: target.phone_number,
          sentCount: job.sentCount,
          failCount: job.failCount,
        });
      } else {
        // Kembalikan ke pending agar bisa dicoba lagi
        await db.query("UPDATE targets SET status='pending', sent_at=NULL WHERE id=$1", [target.id]);
        await db.query(
          'INSERT INTO send_logs (session_id, user_id, phone_number, status, cost) VALUES ($1,$2,$3,$4,$5)',
          [sessionId, sess.uid, target.phone_number, 'failed', 0]
        );
        job.failCount++;
      }

      if (!job.abort) await sleep(randomDelay(delay));
    }

    job.running = false;
    blastJobs.set(sessionId, job);
  };

  runLoop().catch(err => {
    console.error(`Blast error [${sessionId}]:`, err);
    job.running = false;
    eventCallback({ type: 'error', message: err.message });
  });

  return { success: true, message: 'Blast dimulai.' };
}

// ─── Stop Blast ────────────────────────────────────────────────────────────────
function stopBlast(sessionId) {
  const job = blastJobs.get(sessionId);
  if (job) {
    job.abort   = true;
    job.running = false;
  }
}

function _stopBlastInternal(sessionId, reason) {
  stopBlast(sessionId);
  notify(sessionId, { type: 'stopped', reason, sessionId });
}

// ─── Logout ────────────────────────────────────────────────────────────────────
async function logoutSession(sessionId) {
  const sock = sessions.get(sessionId);
  stopBlast(sessionId);
  try { if (sock) await sock.logout(); } catch (_) {}
  sessions.delete(sessionId);
  await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
  _cleanSessionFiles(sessionId);
}

// ─── Update profil semua sesi aktif ───────────────────────────────────────────
// FIX 3: Dipanggil dari admin.js saat admin mengubah setting profil universal.
async function updateAllProfilePic(imageUrl) {
  const res = await db.query("SELECT id FROM wa_sessions WHERE status='connected'");
  let count = 0;
  for (const row of res.rows) {
    const sock = sessions.get(row.id);
    if (!sock) continue;
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      await sock.updateProfilePicture(sock.user.id, Buffer.from(imgRes.data));
      count++;
    } catch (err) {
      console.error(`[${row.id}] updateProfilePic error:`, err.message);
    }
  }
  return count;
}

async function updateAllProfileName(name) {
  const res = await db.query("SELECT id FROM wa_sessions WHERE status='connected'");
  let count = 0;
  for (const row of res.rows) {
    const sock = sessions.get(row.id);
    if (!sock) continue;
    try {
      await sock.updateProfileName(name);
      count++;
    } catch (err) {
      console.error(`[${row.id}] updateProfileName error:`, err.message);
    }
  }
  return count;
}

// ─── Init semua sesi saat startup ─────────────────────────────────────────────
async function initAllSessions() {
  const res = await db.query("SELECT id FROM wa_sessions WHERE status != 'banned'");
  for (const row of res.rows) {
    try {
      await connectSession(row.id);
    } catch (err) {
      console.error(`Init session [${row.id}] error:`, err.message);
    }
  }
  console.log(`✅ Restored ${res.rows.length} WA session(s)`);
}

// ─── Getters ───────────────────────────────────────────────────────────────────
function getBlastJob(sessionId)  { return blastJobs.get(sessionId) || { running: false }; }
function isConnected(sessionId)  { return sessions.has(sessionId); }
function getAllSessions()         { return sessions; }

module.exports = {
  connectSession,
  sendMessage,
  startBlast,
  stopBlast,
  logoutSession,
  updateAllProfilePic,
  updateAllProfileName,
  initAllSessions,
  getBlastJob,
  isConnected,
  getAllSessions,
};
