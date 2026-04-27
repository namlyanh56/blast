'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('./config/db');
const wa   = require('./services/whatsapp');
const { startServer } = require('./server');

// ─── Ensure directories ───────────────────────────────────────────────────────
const dirs = [
  process.env.SESSION_DIR || './sessions',
  './database',
];
for (const d of dirs) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─── Init DB schema ───────────────────────────────────────────────────────────
async function initDB() {
  const schemaPath = path.join(__dirname, 'database', 'schema.sql');
  const schema     = fs.readFileSync(schemaPath, 'utf8');
  try {
    await db.query(schema);
    console.log('✅ Database schema ready');
  } catch (err) {
    // Ignore "already exists" errors
    if (!err.message.includes('already exists')) {
      console.error('❌ DB init error:', err.message);
      throw err;
    }
    console.log('✅ Database tables already exist');
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`\n⚠️  Received ${signal}. Shutting down gracefully...`);
  try {
    // Stop all blast jobs
    const { getAllSessions } = require('./services/whatsapp');
    for (const [sessionId] of getAllSessions()) {
      wa.stopBlast(sessionId);
    }
    await db.pool?.end?.();
  } catch (_) {}
  console.log('👋 Bye!');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});

// ─── Main boot sequence ───────────────────────────────────────────────────────
(async () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║      WA BLAST SYSTEM — STARTING        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // 1. DB
  await initDB();

  // 2. Express API server
  startServer();

  // 3. Telegram Bot (loads router which sets up all handlers)
  require('./bot/router');
  console.log('✅ Telegram Bot started (polling)');

  // 4. Restore WhatsApp sessions
  console.log('📱 Restoring WhatsApp sessions...');
  await wa.initAllSessions();

  console.log('');
  console.log('🚀 System fully booted. Bot is ready!');
  console.log('');
})();
