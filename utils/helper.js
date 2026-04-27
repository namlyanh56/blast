'use strict';

/**
 * Convert basic HTML tags to WhatsApp formatting
 * <b>bold</b> → *bold*
 * <i>italic</i> → _italic_
 * <s>strike</s> → ~~strike~~
 * <code>code</code> → `code`
 * <br>, <p> → newline
 */
function htmlToWa(text) {
  if (!text) return '';
  return text
    .replace(/<b>([\s\S]*?)<\/b>/gi, '*$1*')
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '*$1*')
    .replace(/<i>([\s\S]*?)<\/i>/gi, '_$1_')
    .replace(/<em>([\s\S]*?)<\/em>/gi, '_$1_')
    .replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~')
    .replace(/<del>([\s\S]*?)<\/del>/gi, '~~$1~~')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Format number as Indonesian Rupiah
 */
function formatRupiah(amount) {
  return 'Rp ' + Number(amount).toLocaleString('id-ID');
}

/**
 * Normalize phone number to international format (without +)
 * Returns the full JID like 628123456789@s.whatsapp.net
 */
function normalizePhone(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.startsWith('0')) num = '62' + num.slice(1);
  if (!num.startsWith('62')) num = '62' + num;
  return num + '@s.whatsapp.net';
}

/**
 * Extract plain phone number (no JID suffix)
 */
function plainPhone(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.startsWith('0')) num = '62' + num.slice(1);
  if (!num.startsWith('62')) num = '62' + num;
  return num;
}

/**
 * Check if phone number is valid
 */
function isValidPhone(phone) {
  const num = String(phone).replace(/\D/g, '');
  return num.length >= 8 && num.length <= 15 && /^\d+$/.test(num);
}

/**
 * Parse TXT file content into array of unique valid phone numbers
 */
function parseTxtNumbers(content) {
  const seen = new Set();
  const lines = content.split(/[\n\r,;|\t]+/);
  const results = [];
  for (const line of lines) {
    const num = line.trim();
    if (isValidPhone(num) && !seen.has(num)) {
      seen.add(num);
      results.push(num);
    }
  }
  return results;
}

/**
 * Promise-based sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Random delay with jitter (helps avoid WA spam detection)
 */
function randomDelay(baseMs) {
  const jitter = Math.floor(Math.random() * 1500);
  return baseMs + jitter;
}

/**
 * Chunk an array into smaller arrays
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Format large numbers with dot separator
 */
function formatNumber(n) {
  return Number(n).toLocaleString('id-ID');
}

/**
 * Safe JSON parse
 */
function safeJson(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Truncate text to maxLen chars
 */
function truncate(text, maxLen = 30) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Build a progress bar string
 * e.g. progress(45, 100, 10) → "████░░░░░░ 45%"
 */
function progressBar(current, total, barLen = 10) {
  if (total === 0) return `${'░'.repeat(barLen)} 0%`;
  const pct = Math.min(100, Math.round((current / total) * 100));
  const filled = Math.round((pct / 100) * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
  return `${bar} ${pct}%`;
}

module.exports = {
  htmlToWa,
  formatRupiah,
  normalizePhone,
  plainPhone,
  isValidPhone,
  parseTxtNumbers,
  sleep,
  randomDelay,
  chunkArray,
  formatNumber,
  safeJson,
  truncate,
  progressBar,
};
