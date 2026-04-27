'use strict';

const axios  = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const MERCHANT_CODE = process.env.DUITKU_MERCHANT_CODE || '';
const API_KEY       = process.env.DUITKU_API_KEY       || '';
const BASE_URL      = process.env.DUITKU_BASE_URL      || 'https://passport.duitku.com/webapi';

/**
 * Kode bank/dompet digital untuk Duitku disbursement.
 * Verifikasi kode aktual di dashboard Duitku Anda.
 */
const WALLET_CODES = {
  'Dana':       'DANA',
  'ShopeePay':  'SHOPEE',
  'GoPay':      'GOPAY',
  'OVO':        'OVO',
};

const WALLET_METHODS = Object.keys(WALLET_CODES);

/**
 * Buat disbursement (kirim uang ke rekening/dompet klien)
 * @param {object} param
 * @param {number} param.amount          - Nominal dalam Rupiah
 * @param {string} param.bankCode        - Kode bank dari WALLET_CODES
 * @param {string} param.accountNumber   - Nomor akun/dompet tujuan
 * @param {string} param.accountName     - Nama pemilik akun
 * @param {string} param.description     - Keterangan transfer
 * @returns {Promise<{success, disburseId, data, error}>}
 */
async function createDisbursement({ amount, bankCode, accountNumber, accountName, description }) {
  try {
    const disburseId  = `WBL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const timestamp   = Math.floor(Date.now() / 1000).toString();

    // Signature: MD5(merchantCode + amount + disburseId + apiKey)
    const rawSig  = `${MERCHANT_CODE}${amount}${disburseId}${API_KEY}`;
    const signature = crypto.createHash('md5').update(rawSig).digest('hex');

    const payload = {
      merchantCode:    MERCHANT_CODE,
      disburseId,
      bankCode,
      amount:          String(amount),
      bankAccount:     accountNumber,
      bankAccountName: accountName,
      email:           'noreply@wablast.id',
      phoneNumber:     accountNumber,
      description:     description || 'Penarikan Saldo WA Blast',
      timestamp,
      signature,
    };

    const response = await axios.post(
      `${BASE_URL}/api/disbursement/request`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );

    const isSuccess = response.data?.responseCode === '00';
    return {
      success:    isSuccess,
      disburseId,
      data:       response.data,
      error:      isSuccess ? null : response.data?.responseMessage,
    };
  } catch (err) {
    const errMsg = err.response?.data?.responseMessage || err.message;
    console.error('❌ Duitku disbursement error:', errMsg);
    return { success: false, disburseId: null, data: null, error: errMsg };
  }
}

/**
 * Cek status disbursement
 */
async function checkDisbursementStatus(disburseId) {
  try {
    const rawSig    = `${MERCHANT_CODE}${disburseId}${API_KEY}`;
    const signature = crypto.createHash('md5').update(rawSig).digest('hex');

    const response = await axios.post(
      `${BASE_URL}/api/disbursement/checkstatus`,
      { merchantCode: MERCHANT_CODE, disburseId, signature },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    const code = response.data?.responseCode;
    return {
      success: true,
      status:  code === '00' ? 'success' : code === '01' ? 'processing' : 'failed',
      data:    response.data,
    };
  } catch (err) {
    return { success: false, status: 'unknown', error: err.message };
  }
}

module.exports = {
  createDisbursement,
  checkDisbursementStatus,
  WALLET_CODES,
  WALLET_METHODS,
};
