'use strict';

const { bot, ADMIN_ID, getState, setStep, setData, clearState, safeSend, safeEdit, ack, safeDelete } = require('./core');
const db      = require('../config/db');
const wa      = require('../services/whatsapp');
const { formatRupiah, formatNumber, parseTxtNumbers, progressBar } = require('../utils/helper');

// ─── Keyboards ────────────────────────────────────────────────────────────────
function mainMenuKbd() {
  return {
    inline_keyboard: [
      [{ text: '⚙️ Setting Pesan',   callback_data: 'a:msg'       }, { text: '🔘 Setting Button',  callback_data: 'a:btn'    }],
      [{ text: '👥 Navigator',        callback_data: 'a:nav'       }, { text: '💰 Setting Harga',   callback_data: 'a:price'  }],
      [{ text: '🎯 Setting Target',   callback_data: 'a:target'    }, { text: '👤 Profil WA',       callback_data: 'a:profile'}],
    ],
  };
}

function backKbd(data) {
  return { inline_keyboard: [[{ text: '◀️ Kembali', callback_data: data }]] };
}

// ─── Main Menu ────────────────────────────────────────────────────────────────
async function showMainMenu(chatId) {
  await safeSend(chatId,
    `🤖 *Panel Admin — WA Blast System*\n\nSelamat datang, Admin. Pilih menu:`,
    { reply_markup: mainMenuKbd() }
  );
}

// ─── Setting Pesan ────────────────────────────────────────────────────────────
async function showMsgMenu(chatId) {
  const rows  = await db.query("SELECT value FROM settings WHERE key IN ('message_text','message_image')");
  const st    = {};
  // Re-fetch properly
  const allSt = await db.query("SELECT key, value FROM settings WHERE key IN ('message_text','message_image')");
  for (const r of allSt.rows) st[r.key] = r.value;

  const preview = (st.message_text || '').slice(0, 80);
  const hasImg  = st.message_image && st.message_image.trim() ? '✅ Ada' : '❌ Belum';
  await safeSend(chatId,
    `⚙️ *Setting Pesan*\n\n📝 *Teks saat ini:*\n\`${preview || '(kosong)'}\`\n\n🖼️ *Gambar:* ${hasImg}\n\n_Mendukung tag HTML: \`<b>\`, \`<i>\`, \`<s>\`, \`<code>\`, \`<br>\`_`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Ubah Teks Pesan',    callback_data: 'a:msg_text'  }],
          [{ text: '🖼️ Ubah URL Gambar',    callback_data: 'a:msg_img'   }],
          [{ text: '◀️ Kembali',            callback_data: 'a:main'      }],
        ],
      },
    }
  );
}

// ─── Setting Button ───────────────────────────────────────────────────────────
async function showBtnMenu(chatId) {
  const res = await db.query("SELECT key, value FROM settings WHERE key IN ('button_name','button_url')");
  const st  = {};
  for (const r of res.rows) st[r.key] = r.value;

  await safeSend(chatId,
    `🔘 *Setting Button*\n\n🏷️ *Nama tombol:* \`${st.button_name || '-'}\`\n🔗 *URL:* \`${st.button_url || '-'}\``,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Ubah Nama Button', callback_data: 'a:btn_name' }],
          [{ text: '🔗 Ubah URL Button',  callback_data: 'a:btn_url'  }],
          [{ text: '◀️ Kembali',          callback_data: 'a:main'     }],
        ],
      },
    }
  );
}

// ─── Navigator ────────────────────────────────────────────────────────────────
async function showNavigator(chatId) {
  const [users, activeSess, targetSt] = await Promise.all([
    db.query("SELECT COUNT(*) as cnt FROM users WHERE role='client'"),
    db.query("SELECT COUNT(*) as cnt FROM wa_sessions WHERE status='connected'"),
    db.query(`SELECT
      COUNT(*) FILTER (WHERE status='pending') as pending,
      COUNT(*) FILTER (WHERE status='sent')    as sent,
      COUNT(*) FILTER (WHERE status='failed')  as failed,
      COUNT(*)                                  as total
      FROM targets`),
  ]);

  const t    = targetSt.rows[0];
  const pct  = t.total > 0 ? Math.round((t.sent / t.total) * 100) : 0;
  const bar  = progressBar(parseInt(t.sent), parseInt(t.total), 12);

  await safeSend(chatId,
    `👥 *Navigator Admin*\n\n` +
    `👤 Total Client    : *${formatNumber(users.rows[0].cnt)}*\n` +
    `📱 Akun WA Aktif  : *${formatNumber(activeSess.rows[0].cnt)}*\n\n` +
    `🎯 *Status Target:*\n` +
    `${bar}\n` +
    `├ Total   : *${formatNumber(t.total)}*\n` +
    `├ Terkirim: *${formatNumber(t.sent)}* ✅\n` +
    `├ Pending : *${formatNumber(t.pending)}* ⏳\n` +
    `└ Gagal   : *${formatNumber(t.failed)}* ❌`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Daftar Client',      callback_data: 'a:nav_clients'  }],
          [{ text: '📱 Daftar Akun WA',     callback_data: 'a:nav_sessions' }],
          [{ text: '🔄 Refresh',            callback_data: 'a:nav'          }],
          [{ text: '◀️ Kembali',            callback_data: 'a:main'         }],
        ],
      },
    }
  );
}

async function showClientList(chatId) {
  const res = await db.query(
    `SELECT u.telegram_id, u.full_name, u.username, u.balance,
            COUNT(s.id) as bot_count
     FROM users u
     LEFT JOIN wa_sessions s ON s.user_id = u.id
     WHERE u.role='client'
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT 20`
  );

  if (!res.rows.length) {
    return safeSend(chatId, '📭 Belum ada client terdaftar.', { reply_markup: backKbd('a:nav') });
  }

  let text = '📋 *Daftar Client (maks 20):*\n\n';
  for (const u of res.rows) {
    const name    = u.full_name || u.username || 'Unknown';
    const balance = formatRupiah(u.balance);
    text += `👤 *${name}* (@${u.username || '-'})\n`;
    text += `   💰 Saldo: ${balance} | 📱 Bot: ${u.bot_count}\n\n`;
  }

  await safeSend(chatId, text, { reply_markup: backKbd('a:nav') });
}

async function showSessionList(chatId) {
  const res = await db.query(
    `SELECT s.id, s.session_name, s.phone_number, s.status, u.full_name, u.username
     FROM wa_sessions s
     JOIN users u ON s.user_id = u.id
     ORDER BY s.status DESC, s.id DESC
     LIMIT 30`
  );

  if (!res.rows.length) {
    return safeSend(chatId, '📭 Belum ada sesi WA.', { reply_markup: backKbd('a:nav') });
  }

  let text = '📱 *Daftar Akun WA (maks 30):*\n\n';
  for (const s of res.rows) {
    const icon   = s.status === 'connected' ? '🟢' : s.status === 'banned' ? '🔴' : '🟡';
    const owner  = s.full_name || s.username || 'Unknown';
    text += `${icon} *${s.session_name}* (${s.phone_number || '-'})\n`;
    text += `   Owner: ${owner} | Status: \`${s.status}\`\n\n`;
  }

  await safeSend(chatId, text, { reply_markup: backKbd('a:nav') });
}

// ─── Setting Harga ────────────────────────────────────────────────────────────
async function showPriceMenu(chatId) {
  const res = await db.query("SELECT value FROM settings WHERE key='price_per_message'");
  const price = res.rows[0]?.value || '100';
  await safeSend(chatId,
    `💰 *Setting Harga per Pesan*\n\nHarga saat ini: *${formatRupiah(price)}* / pesan\n\n_Masukkan harga baru (dalam Rupiah, angka saja):_`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Ubah Harga', callback_data: 'a:price_set' }],
          [{ text: '◀️ Kembali',    callback_data: 'a:main'      }],
        ],
      },
    }
  );
}

// ─── Setting Target ───────────────────────────────────────────────────────────
async function showTargetMenu(chatId) {
  const res = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='pending') as pending,
      COUNT(*) FILTER (WHERE status='sent')    as sent,
      COUNT(*) FILTER (WHERE status='failed')  as failed,
      COUNT(*)                                  as total
    FROM targets`);
  const t = res.rows[0];

  await safeSend(chatId,
    `🎯 *Setting Target*\n\n` +
    `📊 *Statistik Real-time:*\n` +
    `├ Total   : *${formatNumber(t.total)}*\n` +
    `├ Pending : *${formatNumber(t.pending)}* ⏳\n` +
    `├ Terkirim: *${formatNumber(t.sent)}* ✅\n` +
    `└ Gagal   : *${formatNumber(t.failed)}* ❌\n\n` +
    `📁 Kirim file *.txt* berisi nomor HP (satu per baris) untuk upload target baru.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📤 Upload TXT',          callback_data: 'a:target_upload'  }],
          [{ text: '🗑️ Hapus Semua Pending',  callback_data: 'a:target_clear'   }],
          [{ text: '🔄 Refresh Statistik',   callback_data: 'a:target'         }],
          [{ text: '◀️ Kembali',             callback_data: 'a:main'           }],
        ],
      },
    }
  );
}

// ─── Profil WA ────────────────────────────────────────────────────────────────
async function showProfileMenu(chatId) {
  await safeSend(chatId,
    `👤 *Profil WA — Pengaturan Universal*\n\n_Perubahan berlaku untuk semua akun WA yang sedang aktif._`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🖼️ Ubah Foto Profil', callback_data: 'a:prof_pic'  }],
          [{ text: '✏️ Ubah Nama Akun',   callback_data: 'a:prof_name' }],
          [{ text: '◀️ Kembali',          callback_data: 'a:main'      }],
        ],
      },
    }
  );
}

// ─── Message Handler (text input) ────────────────────────────────────────────
async function handleAdminMessage(msg, user) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;
  const state  = getState(tid);
  const text   = msg.text?.trim() || '';

  // ── Document upload (TXT targets) ─────────────────────────────────────────
  if (msg.document && state.step === 'a:await_target_upload') {
    const fileId = msg.document.file_id;
    const fname  = msg.document.file_name || '';
    if (!fname.endsWith('.txt') && !fname.endsWith('.csv')) {
      return safeSend(chatId, '❌ File harus berformat *.txt*');
    }

    const loadMsg = await safeSend(chatId, '⏳ Memproses file...');
    try {
      const fileLink = await bot.getFileLink(fileId);
      const axios    = require('axios');
      const resp     = await axios.get(fileLink, { timeout: 30000, responseType: 'text' });
      const numbers  = parseTxtNumbers(resp.data);

      if (!numbers.length) {
        return safeSend(chatId, '❌ Tidak ada nomor valid ditemukan di file.');
      }

      // Batch upsert — skip numbers that are already sent
      let inserted = 0;
      const chunks = [];
      for (let i = 0; i < numbers.length; i += 500) chunks.push(numbers.slice(i, i + 500));

      for (const chunk of chunks) {
        const vals   = chunk.map((_, i) => `($${i + 1})`).join(',');
        const result = await db.query(
          `INSERT INTO targets (phone_number)
           VALUES ${vals}
           ON CONFLICT (phone_number) DO NOTHING`,
          chunk
        );
        inserted += result.rowCount || 0;
      }

      clearState(tid);
      await safeSend(chatId,
        `✅ *Upload Selesai!*\n\n` +
        `📄 Total di file : *${formatNumber(numbers.length)}*\n` +
        `✅ Berhasil tambah: *${formatNumber(inserted)}*\n` +
        `⏭️ Duplikat skip : *${formatNumber(numbers.length - inserted)}*`,
        { reply_markup: backKbd('a:target') }
      );
    } catch (err) {
      console.error('Upload error:', err);
      safeSend(chatId, `❌ Gagal memproses file: ${err.message}`);
    }
    return;
  }

  if (!state.step) return; // no active step

  // ── Text inputs ────────────────────────────────────────────────────────────
  switch (state.step) {
    case 'a:await_msg_text': {
      if (!text) return safeSend(chatId, '❌ Teks tidak boleh kosong.');
      await db.query("UPDATE settings SET value=$1, updated_at=NOW() WHERE key='message_text'", [text]);
      clearState(tid);
      return safeSend(chatId, `✅ *Teks pesan berhasil diperbarui!*\n\nPreview: \`${text.slice(0, 100)}\``, { reply_markup: backKbd('a:msg') });
    }

    case 'a:await_msg_img': {
      const url = text;
      await db.query("UPDATE settings SET value=$1, updated_at=NOW() WHERE key='message_image'", [url]);
      clearState(tid);
      return safeSend(chatId, `✅ URL gambar disimpan:\n\`${url}\``, { reply_markup: backKbd('a:msg') });
    }

    case 'a:await_btn_name': {
      if (!text) return safeSend(chatId, '❌ Nama tidak boleh kosong.');
      await db.query("UPDATE settings SET value=$1, updated_at=NOW() WHERE key='button_name'", [text]);
      clearState(tid);
      return safeSend(chatId, `✅ Nama button disimpan: *${text}*`, { reply_markup: backKbd('a:btn') });
    }

    case 'a:await_btn_url': {
      await db.query("UPDATE settings SET value=$1, updated_at=NOW() WHERE key='button_url'", [text]);
      clearState(tid);
      return safeSend(chatId, `✅ URL button disimpan:\n\`${text}\``, { reply_markup: backKbd('a:btn') });
    }

    case 'a:await_price': {
      const price = parseFloat(text.replace(/\D/g, ''));
      if (isNaN(price) || price < 1) return safeSend(chatId, '❌ Masukkan angka harga yang valid.');
      await db.query("UPDATE settings SET value=$1, updated_at=NOW() WHERE key='price_per_message'", [price]);
      clearState(tid);
      return safeSend(chatId, `✅ Harga per pesan: *${formatRupiah(price)}*`, { reply_markup: backKbd('a:price') });
    }

    case 'a:await_prof_pic': {
      const url = text;
      const loadMsg = await safeSend(chatId, '⏳ Memperbarui foto profil semua akun...');
      const count = await wa.updateAllProfilePic(url);
      await safeDelete(chatId, loadMsg.message_id);
      clearState(tid);
      return safeSend(chatId, `✅ Foto profil diperbarui pada *${count}* akun.`, { reply_markup: backKbd('a:profile') });
    }

    case 'a:await_prof_name': {
      const name = text;
      const loadMsg = await safeSend(chatId, '⏳ Memperbarui nama semua akun...');
      const count = await wa.updateAllProfileName(name);
      await safeDelete(chatId, loadMsg.message_id);
      clearState(tid);
      return safeSend(chatId, `✅ Nama profil diperbarui pada *${count}* akun.`, { reply_markup: backKbd('a:profile') });
    }

    default:
      break;
  }
}

// ─── Callback Handler ─────────────────────────────────────────────────────────
async function handleAdminCallback(query, user) {
  const chatId = query.message.chat.id;
  const tid    = query.from.id;
  const data   = query.data;

  await ack(query.id);

  switch (data) {
    // Main menu
    case 'a:main':      return showMainMenu(chatId);

    // Setting Pesan
    case 'a:msg':       return showMsgMenu(chatId);
    case 'a:msg_text':
      setStep(tid, 'a:await_msg_text');
      return safeSend(chatId, '✏️ Kirimkan teks pesan baru. (Mendukung HTML: `<b>`, `<i>`, `<br>` dll)\n\n_Ketik dan kirim:_');
    case 'a:msg_img':
      setStep(tid, 'a:await_msg_img');
      return safeSend(chatId, '🖼️ Kirimkan URL gambar (https://...) atau ketik `-` untuk hapus gambar:');

    // Setting Button
    case 'a:btn':       return showBtnMenu(chatId);
    case 'a:btn_name':
      setStep(tid, 'a:await_btn_name');
      return safeSend(chatId, '🏷️ Masukkan nama tombol baru (contoh: *Pesan Sekarang*):');
    case 'a:btn_url':
      setStep(tid, 'a:await_btn_url');
      return safeSend(chatId, '🔗 Masukkan URL tombol (contoh: https://wa.me/62812345):');

    // Navigator
    case 'a:nav':           return showNavigator(chatId);
    case 'a:nav_clients':   return showClientList(chatId);
    case 'a:nav_sessions':  return showSessionList(chatId);

    // Setting Harga
    case 'a:price':     return showPriceMenu(chatId);
    case 'a:price_set':
      setStep(tid, 'a:await_price');
      return safeSend(chatId, '💰 Masukkan harga baru per pesan (Rupiah, angka saja):\nContoh: `500`');

    // Setting Target
    case 'a:target':    return showTargetMenu(chatId);
    case 'a:target_upload':
      setStep(tid, 'a:await_target_upload');
      return safeSend(chatId, '📤 Kirimkan file *.txt* berisi nomor target (satu nomor per baris).\nMaksimal 500.000 nomor per upload.\n\nFormat: `08123456789` atau `628123456789`');
    case 'a:target_clear': {
      const res = await db.query("DELETE FROM targets WHERE status='pending'");
      return safeSend(chatId, `🗑️ *${formatNumber(res.rowCount)}* nomor pending telah dihapus.`, { reply_markup: backKbd('a:target') });
    }

    // Profil
    case 'a:profile':    return showProfileMenu(chatId);
    case 'a:prof_pic':
      setStep(tid, 'a:await_prof_pic');
      return safeSend(chatId, '🖼️ Kirimkan URL foto profil baru (https://...) untuk semua akun WA:');
    case 'a:prof_name':
      setStep(tid, 'a:await_prof_name');
      return safeSend(chatId, '✏️ Masukkan nama profil baru untuk semua akun WA:');

    default:
      break;
  }
}

module.exports = { showMainMenu, handleAdminMessage, handleAdminCallback };
