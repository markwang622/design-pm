// ─────────────────────────────────────────────────────────────
// v7.3 邀請啟用 — token 產生與驗證
//
// 設計原則：
//   1. 明碼 token 只在建立當下回傳一次，DB 只存 SHA-256。
//      即使資料庫外洩，也無法用存下來的值去啟用任何帳號。
//   2. 一次性：啟用成功即清除，無法重複使用。
//   3. 有效期預設 7 天，過期需由管理員重新產生。
//   4. 未啟用帳號的 password 欄位放一段不可能被猜中的隨機 hash，
//      確保在啟用前沒有任何密碼可以登入。
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';

export const ACTIVATION_TTL_DAYS = 7;

export function generateActivationToken() {
  const token = crypto.randomBytes(32).toString('hex'); // 64 字元，256 bits
  const expires = new Date(Date.now() + ACTIVATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, hash: hashToken(token), expires };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// 未啟用帳號的佔位密碼：隨機且不外流，任何輸入都無法比對成功
export function unusablePassword() {
  return crypto.randomBytes(48).toString('hex');
}

export function activationUrl(req, token) {
  const base = process.env.APP_BASE_URL
    || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
  return `${base.replace(/\/+$/, '')}/activate?token=${token}`;
}
