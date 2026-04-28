'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino   = require('pino');
const path   = require('path');
const fs     = require('fs');
const axios  = require('axios');

const db     = require('../config/db');
const { htmlToWa, normalizePhone, sleep, randomDelay } = require('../utils/helper');

require('dotenv').config();

// ─── In-memory stores ────────────────────────────────────────────────────────
const sessions      = new Map(); // Map<sessionId, WASocket>
const blastJobs     = new Map(); // Map<sessionId, { running, abort, sentCount, failCount }>
const blastCallbacks = new Map(); // Map<sessionId, Function>

const SESSION_DIR = process.env.SESSION_DIR || './sessions';
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sessionPath(sessionId) {
  return path.join(SESSION_DIR, `sess_${sessionId}`);
}

function notify(sessionId, data) {
  const cb = blastCallbacks.get(sessionId);
  if (cb) cb(data);
}

// ─── Apply saved profile settings to a connected socket ──────────────────────
// FIX 3: Dipanggil setiap kali sesi baru berhasil connect, agar setting
// profile_name & profile_pic dari admin langsung diterapkan secara otomatis.
async function _applyProfileSettings(sessionId, sock) {
  try {
    const res = await db.query(
      "SELECT key, value FROM settings WHERE key IN ('profile_name','profile_pic')"
    );
    const st = {};
    for (const r of res.rows) st[r.key] = r.value;

    if (st.profile_name?.trim()) {
      try {
        await sock.updateProfileName(st.profile_name.trim());
      } catch (e) {
        console.error(`[Session ${sessionId}] apply profile_name error:`, e.message);
      }
    }

    if (st.profile_pic?.trim()) {
      try {
        const imgRes = await axios.get(st.profile_pic.trim(), { responseType: 'arraybuffer', timeout: 10000 });
        await sock.updateProfilePicture(sock.user.id, Buffer.from(imgRes.data));
      } catch (e) {
        console.error(`[Session ${sessionId}] apply profile_pic error:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[Session ${sessionId}] _applyProfileSettings error:`, e.message);
  }
}

// ─── Connect Session ─────────────────────────────────────────────────────────
/**
 * Connect / reconnect a WhatsApp session.
 *
 * FIX 2: Pairing code kini direquest di dalam event `connection.update`
 * saat Baileys benar-benar siap (creds.registered === false + koneksi open/QR),
 * menggunakan setTimeout 3 detik agar socket stabil sebelum requestPairingCode.
 * Ini mencegah kode palsu/garbage yang terjadi ketika kode diminta terlalu dini.
 *
 * @param {number}   sessionId
 * @param {string}   [phoneNumber]  - Required for pairing code flow
 * @param {Function} [pairingCb]    - Called with (code, null) or (null, errMsg)
 */
async function connectSession(sessionId, phoneNumber = null, pairingCb = null) {
  if (sessions.has(sessionId)) return;

  await db.query("UPDATE wa_sessions SET status='connecting' WHERE id=$1", [sessionId]);

  const authPath = sessionPath(sessionId);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version }          = await fetchLatestBaileysVersion();

  const cleanPhone = phoneNumber
    ? String(phoneNumber).replace(/\D/g, '').replace(/^0/, '62')
    : null;

  // Pairing mode: nomor ada, callback ada, belum registered
  const usePairing = !!(cleanPhone && pairingCb && !state.creds.registered);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ['WA-Blast', 'Chrome', '120.0.0'],
  });

  sessions.set(sessionId, sock);

  // ── FIX 2: Request pairing code dengan timing yang benar ──────────────────
  // Baileys harus dalam kondisi "registered === false" dan socket sudah
  // menyelesaikan handshake WS. Kita tunggu event connection.update pertama,
  // lalu delay 3 detik sebelum requestPairingCode agar tidak menghasilkan kode palsu.
  let pairingRequested = false;

  if (usePairing) {
    sock.ev.on('connection.update', async (update) => {
      // Hanya proses satu kali
      if (pairingRequested) return;

      const { connection, qr } = update;

      // Baileys mengirim event qr ATAU connection='open' di fase awal.
      // Kita request pairing code setelah salah satu terjadi.
      const isReady = qr || connection === 'open';
      if (!isReady) return;

      pairingRequested = true;

      // Delay 3 detik — member socket stabil (sesuai contoh referensi)
      setTimeout(async () => {
        try {
          const code      = await sock.requestPairingCode(cleanPhone);
          // Format XXXX-XXXX agar mudah dibaca
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          pairingCb(formatted, null);
        } catch (err) {
          console.error(`[Session ${sessionId}] requestPairingCode error:`, err.message);
          pairingCb(null, err.message);
          // Bersihkan sesi gagal
          sessions.delete(sessionId);
          await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
          _cleanSessionFiles(sessionId);
        }
      }, 3000);
    });
  }

  // ── Connection Events ─────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || '';
      await db.query(
        "UPDATE wa_sessions SET status='connected', phone_number=$1, last_connected=NOW() WHERE id=$2",
        [phone, sessionId]
      );
      console.log(`✅ [Session ${sessionId}] Connected: ${phone}`);

      // FIX 3: Terapkan profile settings yang sudah diset admin
      await _applyProfileSettings(sessionId, sock);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      sessions.delete(sessionId);

      console.log(`⚠️  [Session ${sessionId}] Closed. Code: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
        _cleanSessionFiles(sessionId);
        notify(sessionId, { type: 'logout', sessionId });
      } else if (statusCode === 403) {
        await db.query("UPDATE wa_sessions SET status='banned' WHERE id=$1", [sessionId]);
        _stopBlastInternal(sessionId, 'banned');
        notify(sessionId, { type: 'banned', sessionId });
      } else {
        await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
        _stopBlastInternal(sessionId, 'disconnected');
        notify(sessionId, { type: 'disconnected', sessionId });
        // Auto-reconnect setelah 8 detik
        setTimeout(() => connectSession(sessionId), 8000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─── Send Message ─────────────────────────────────────────────────────────────
async function sendMessage(sessionId, phoneJid, { text, imageUrl, buttonName, buttonUrl }) {
  const sock = sessions.get(sessionId);
  if (!sock) return false;

  try {
    let result = null;

    if (imageUrl && imageUrl.trim()) {
      try {
        result = await sock.sendMessage(phoneJid, {
          image:      { url: imageUrl },
          caption:    text,
          buttons:    [{ buttonId: 'btn_link', buttonText: { displayText: buttonName }, type: 1 }],
          footer:     buttonUrl,
          headerType: 4,
        });
      } catch {
        result = await sock.sendMessage(phoneJid, {
          image:   { url: imageUrl },
          caption: `${text}\n\n🔗 *${buttonName}*\n${buttonUrl}`,
        });
      }
    } else {
      try {
        result = await sock.sendMessage(phoneJid, {
          text:    text,
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

// ─── Start Blast ──────────────────────────────────────────────────────────────
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
      const statusRow = await db.query('SELECT status FROM wa_sessions WHERE id=$1', [sessionId]);
      const curStatus = statusRow.rows[0]?.status;
      if (curStatus !== 'connected') {
        eventCallback({
          type: 'stopped',
          reason: curStatus === 'banned' ? '🚫 Akun di-ban' : '🔌 Akun terputus',
          lastPhone,
          sentCount: job.sentCount,
          failCount: job.failCount,
        });
        break;
      }

      const targetRes = await db.query(
        `UPDATE targets SET status='sent'
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
        await db.query("UPDATE targets SET sent_at=NOW(), sent_by_session=$1 WHERE id=$2", [sessionId, target.id]);
        await db.query(
          'INSERT INTO send_logs (session_id, user_id, phone_number, status, cost) VALUES ($1,$2,$3,$4,$5)',
          [sessionId, sess.uid, target.phone_number, 'sent', price]
        );
        await db.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [price, sess.uid]);
        await db.query('UPDATE wa_sessions SET last_msg_index = last_msg_index + 1 WHERE id=$1', [sessionId]);
        job.sentCount++;
        eventCallback({ type: 'progress', phone: target.phone_number, sentCount: job.sentCount, failCount: job.failCount });
      } else {
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
    console.error(`Blast error [session ${sessionId}]:`, err);
    job.running = false;
    eventCallback({ type: 'error', message: err.message });
  });

  return { success: true, message: 'Blast dimulai.' };
}

// ─── Stop Blast ───────────────────────────────────────────────────────────────
function stopBlast(sessionId) {
  const job = blastJobs.get(sessionId);
  if (job) { job.abort = true; job.running = false; }
}

function _stopBlastInternal(sessionId, reason) {
  stopBlast(sessionId);
  notify(sessionId, { type: 'stopped', reason, sessionId });
}

// ─── Logout Session ───────────────────────────────────────────────────────────
async function logoutSession(sessionId) {
  const sock = sessions.get(sessionId);
  stopBlast(sessionId);
  try { if (sock) await sock.logout(); } catch (_) {}
  sessions.delete(sessionId);
  await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
  _cleanSessionFiles(sessionId);
}

function _cleanSessionFiles(sessionId) {
  const p = sessionPath(sessionId);
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ─── Update Profile for All Connected Sessions ────────────────────────────────
async function updateAllProfilePic(imageUrl) {
  const res = await db.query("SELECT id FROM wa_sessions WHERE status='connected'");
  let count = 0;
  for (const row of res.rows) {
    const sock = sessions.get(row.id);
    if (!sock) continue;
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      await sock.updateProfilePicture(sock.user.id, Buffer.from(imgRes.data));
      count++;
    } catch (err) {
      console.error(`Profile pic error [${row.id}]:`, err.message);
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
      console.error(`Profile name error [${row.id}]:`, err.message);
    }
  }
  return count;
}

// ─── Init all sessions on startup ────────────────────────────────────────────
async function initAllSessions() {
  const res = await db.query("SELECT id FROM wa_sessions WHERE status != 'banned'");
  for (const row of res.rows) {
    try { await connectSession(row.id); } catch (err) {
      console.error(`Init session ${row.id} error:`, err.message);
    }
  }
  console.log(`✅ Restored ${res.rows.length} WA session(s)`);
}

// ─── Getters ──────────────────────────────────────────────────────────────────
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
