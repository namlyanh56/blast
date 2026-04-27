'use strict';

const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// ─── Bot instance ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
});

const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);

// ─── State machine ────────────────────────────────────────────────────────────
/** Map<telegramId, { step: string, data: object }> */
const userState = new Map();

function getState(tid)          { return userState.get(tid) || { step: null, data: {} }; }
function setState(tid, patch)   { userState.set(tid, { ...getState(tid), ...patch }); }
function setStep(tid, step)     { setState(tid, { step }); }
function setData(tid, data)     { setState(tid, { data: { ...getState(tid).data, ...data } }); }
function clearState(tid)        { userState.delete(tid); }

// ─── User registration / lookup ───────────────────────────────────────────────
const db = require('../config/db');

async function getOrRegisterUser(from) {
  const role     = from.id === ADMIN_ID ? 'admin' : 'client';
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const res = await db.query(
    `INSERT INTO users (telegram_id, username, full_name, role)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = EXCLUDED.username, full_name = EXCLUDED.full_name
     RETURNING *`,
    [from.id, from.username || '', fullName, role]
  );
  return res.rows[0];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safe sendMessage — absorbs errors */
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
  } catch (err) {
    console.error(`safeSend error [${chatId}]:`, err.message);
  }
}

/** Edit existing message text */
async function safeEdit(chatId, messageId, text, opts = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', ...opts,
    });
  } catch (_) {}
}

/** Answer callback query silently */
async function ack(callbackQueryId, text = '') {
  try { await bot.answerCallbackQuery(callbackQueryId, { text }); } catch (_) {}
}

/** Delete message safely */
async function safeDelete(chatId, messageId) {
  try { await bot.deleteMessage(chatId, messageId); } catch (_) {}
}

module.exports = {
  bot,
  ADMIN_ID,
  getState,
  setState,
  setStep,
  setData,
  clearState,
  getOrRegisterUser,
  safeSend,
  safeEdit,
  ack,
  safeDelete,
};
