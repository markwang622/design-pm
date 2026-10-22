import crypto from 'node:crypto';
import { prisma } from '../lib/db.js';
import { hashToken } from '../lib/activation.js';
import { deliver } from './notify.js';

export const RESET_TTL_MINUTES = 30;
export const recoveryEmailReady = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.APP_BASE_URL);

export function recoveryUrl(token) {
  // Never construct credential links from the untrusted request Host header.
  const base = new URL(process.env.APP_BASE_URL);
  if (base.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost','127.0.0.1'].includes(base.hostname))) throw new Error('invalid_app_base_url');
  return new URL('/reset-password.html#' + token, base).href;
}

export async function createRecovery(staffId) {
  const token = crypto.randomBytes(32).toString('hex');
  const url = recoveryUrl(token);
  const expires = new Date(Date.now() + RESET_TTL_MINUTES * 60000);
  await prisma.staff.update({ where: { id: staffId }, data: { resetTokenHash: hashToken(token), resetExpires: expires } });
  return { url, expires, hash: hashToken(token) };
}

export async function passwordChangedNotice(staff) {
  return deliver(staff.email, '【帳號安全】密碼已更新', '你的專案管理帳號密碼已更新，所有舊登入已失效。\n若這不是你的操作，請立即聯絡管理員。');
}
