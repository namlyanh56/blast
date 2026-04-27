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
/** Map<sessionId (number), WASocket> */
const sessions = new Map();

/** Map<sessionId, { running: bool, abort: bool, sentCount, failCount }> */
const blastJobs = new Map();

/** Callback registry for blast events: Map<sessionId, Function> */
const blastCallbacks = new Map();

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

// ─── Connect Session ─────────────────────────────────────────────────────────
/**
 * Connect / reconnect a WhatsApp session.
 * @param {number}   sessionId      - DB row ID in wa_sessions
 * @param {string}   [phoneNumber]  - Required for pairing code flow
 * @param {Function} [pairingCb]    - Called with (code) or (null, errMsg)
 */
async function connectSession(sessionId, phoneNumber = null, pairingCb = null) {
  // Avoid duplicate connections
  if (sessions.has(sessionId)) return;

  await db.query("UPDATE wa_sessions SET status='connecting' WHERE id=$1", [sessionId]);

  const authPath = sessionPath(sessionId);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  // Normalize phone: strip non-digits, ensure starts with country code
  const cleanPhone = phoneNumber
    ? String(phoneNumber).replace(/\D/g, '').replace(/^0/, '62')
    : null;

  // Pairing code mode: must tell Baileys upfront via `mobile: true`
  // and provide the phone number so it skips QR generation
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
    // Disable QR so Baileys enters pairing-code mode automatically
    ...(usePairing ? { mobile: false } : {}),
  });

  sessions.set(sessionId, sock);

  // ── Pairing Code ────────────────────────────────────────────────────────────
  // Request the code ONLY after Baileys fires the `qr` event,
  // which means the WS handshake is done and the server is waiting.
  // Requesting before this point yields a garbage/fake code.
  let pairingRequested = false;

  if (usePairing) {
    sock.ev.on('connection.update', async (update) => {
      // `qr` field being present means socket is in auth-waiting state
      if (update.qr && !pairingRequested) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          // Baileys returns 8-char string; format as XXXX-XXXX for readability
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          pairingCb(formatted, null);
        } catch (err) {
          pairingCb(null, err.message);
          // Clean up failed session
          sessions.delete(sessionId);
          await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
          _cleanSessionFiles(sessionId);
        }
      }
    });
  }

  // ── Connection Events ────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || '';
      await db.query(
        "UPDATE wa_sessions SET status='connected', phone_number=$1, last_connected=NOW() WHERE id=$2",
        [phone, sessionId]
      );
      console.log(`✅ [Session ${sessionId}] Connected: ${phone}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      sessions.delete(sessionId);

      console.log(`⚠️  [Session ${sessionId}] Closed. Code: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        // Logged out — cleanup
        await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
        _cleanSessionFiles(sessionId);
        notify(sessionId, { type: 'logout', sessionId });
      } else if (statusCode === 403) {
        // Banned
        await db.query("UPDATE wa_sessions SET status='banned' WHERE id=$1", [sessionId]);
        _stopBlastInternal(sessionId, 'banned');
        notify(sessionId, { type: 'banned', sessionId });
      } else {
        // Reconnectable
        await db.query("UPDATE wa_sessions SET status='disconnected' WHERE id=$1", [sessionId]);
        _stopBlastInternal(sessionId, 'disconnected');
        notify(sessionId, { type: 'disconnected', sessionId });
        // Auto-reconnect after 8s
        setTimeout(() => connectSession(sessionId), 8000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─── Send Message (with button fallback) ─────────────────────────────────────
/**
 * Send WA message with button. Falls back to plain text + URL if buttons unsupported.
 * @returns {boolean} true = sent successfully
 */
async function sendMessage(sessionId, phoneJid, { text, imageUrl, buttonName, buttonUrl }) {
  const sock = sessions.get(sessionId);
  if (!sock) return false;

  try {
    let result = null;

    if (imageUrl && imageUrl.trim()) {
      // ── Image + caption + button ──────────────────────────────────────────
      try {
        result = await sock.sendMessage(phoneJid, {
          image:      { url: imageUrl },
          caption:    text,
          buttons:    [{ buttonId: 'btn_link', buttonText: { displayText: buttonName }, type: 1 }],
          footer:     buttonUrl,
          headerType: 4,
        });
      } catch {
        // Fallback: image with caption + URL text
        result = await sock.sendMessage(phoneJid, {
          image:   { url: imageUrl },
          caption: `${text}\n\n🔗 *${buttonName}*\n${buttonUrl}`,
        });
      }
    } else {
      // ── Text + button ─────────────────────────────────────────────────────
      try {
        result = await sock.sendMessage(phoneJid, {
          text:    text,
          buttons: [{ buttonId: 'btn_link', buttonText: { displayText: buttonName }, type: 1 }],
          footer:  buttonUrl,
        });
      } catch {
        // Fallback: plain text with URL
        result = await sock.sendMessage(phoneJid, {
          text: `${text}\n\n🔗 *${buttonName}*: ${buttonUrl}`,
        });
      }
    }

    // sendMessage returning a result object means it was accepted by WA servers
    return !!result;
  } catch (err) {
    console.error(`❌ Send error → ${phoneJid}: ${err.message}`);
    return false;
  }
}

// ─── Start Blast ─────────────────────────────────────────────────────────────
/**
 * Start the blast job for a session.
 * @param {number}   sessionId
 * @param {Function} eventCallback  - called with event objects during blast
 */
async function startBlast(sessionId, eventCallback) {
  if (blastJobs.get(sessionId)?.running) {
    return { success: false, message: 'Blast sudah berjalan untuk akun ini.' };
  }

  const sock = sessions.get(sessionId);
  if (!sock) return { success: false, message: 'Akun tidak terhubung ke WhatsApp.' };

  // Fetch session + owner info
  const sessRes = await db.query(
    `SELECT s.*, u.id as uid FROM wa_sessions s
     JOIN users u ON s.user_id = u.id WHERE s.id=$1`,
    [sessionId]
  );
  if (!sessRes.rows.length) return { success: false, message: 'Sesi tidak ditemukan.' };
  const sess = sessRes.rows[0];

  // Fetch settings
  const stRes = await db.query('SELECT key, value FROM settings');
  const st = {};
  for (const r of stRes.rows) st[r.key] = r.value;

  const price       = parseFloat(st.price_per_message || '100');
  const msgText     = htmlToWa(st.message_text || '');
  const imageUrl    = st.message_image  || '';
  const buttonName  = st.button_name   || 'Kunjungi';
  const buttonUrl   = st.button_url    || 'https://example.com';
  const delay       = sess.delay_ms    || 3000;

  const job = { running: true, abort: false, sentCount: 0, failCount: 0 };
  blastJobs.set(sessionId, job);
  blastCallbacks.set(sessionId, eventCallback);

  // ── Blast Loop ──────────────────────────────────────────────────────────────
  const runLoop = async () => {
    let lastPhone = '';

    while (!job.abort) {
      // Check session status in DB
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

      // Grab next pending target (atomic via UPDATE ... RETURNING)
      const targetRes = await db.query(
        `UPDATE targets SET status='sent'
         WHERE id = (
           SELECT id FROM targets WHERE status='pending'
           ORDER BY id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, phone_number`
      );

      if (!targetRes.rows.length) {
        // No more targets
        eventCallback({ type: 'done', sentCount: job.sentCount, failCount: job.failCount });
        break;
      }

      const target     = targetRes.rows[0];
      const phoneJid   = normalizePhone(target.phone_number);
      lastPhone        = target.phone_number;

      const ok = await sendMessage(sessionId, phoneJid, { text: msgText, imageUrl, buttonName, buttonUrl });

      if (ok) {
        // Confirm sent
        await db.query(
          "UPDATE targets SET sent_at=NOW(), sent_by_session=$1 WHERE id=$2",
          [sessionId, target.id]
        );
        // Log + credit user balance
        await db.query(
          'INSERT INTO send_logs (session_id, user_id, phone_number, status, cost) VALUES ($1,$2,$3,$4,$5)',
          [sessionId, sess.uid, target.phone_number, 'sent', price]
        );
        await db.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [price, sess.uid]);
        await db.query('UPDATE wa_sessions SET last_msg_index = last_msg_index + 1 WHERE id=$1', [sessionId]);

        job.sentCount++;
        eventCallback({ type: 'progress', phone: target.phone_number, sentCount: job.sentCount, failCount: job.failCount });
      } else {
        // Revert target to pending
        await db.query("UPDATE targets SET status='pending', sent_at=NULL WHERE id=$1", [target.id]);
        await db.query(
          'INSERT INTO send_logs (session_id, user_id, phone_number, status, cost) VALUES ($1,$2,$3,$4,$5)',
          [sessionId, sess.uid, target.phone_number, 'failed', 0]
        );
        job.failCount++;
      }

      if (!job.abort) {
        await sleep(randomDelay(delay));
      }
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
  if (job) {
    job.abort   = true;
    job.running = false;
  }
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

// ─── Update Profile for All Connected Sessions ───────────────────────────────
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
