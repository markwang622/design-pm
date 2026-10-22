import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { hashToken } from '../lib/activation.js';
import { requireAuth, requireAdmin, clearAuthCookie, validatePasswordStrength } from '../middleware/auth.js';
import { deliver } from '../services/notify.js';
import { createRecovery, recoveryEmailReady, passwordChangedNotice } from '../services/passwordRecovery.js';

const router = Router();
const post = (path, ...handlers) => router.post(path, ...handlers.map(handler =>
  handler.constructor.name === 'AsyncFunction' ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) : handler));
const requestLimit = rateLimit({ windowMs: 3600000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests', message: '重設要求過於頻繁，請稍後再試或聯絡管理員' } });
const tokenLimit = rateLimit({ windowMs: 900000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests', message: '要求過於頻繁，請稍後再試' } });
const adminLinkLimit = rateLimit({ windowMs: 3600000, max: 50, standardHeaders: true, legacyHeaders: false });
const generic = { ok: true, message: '若此信箱為已啟用帳號，將收到 30 分鐘內有效的重設連結；未收到請聯絡管理員。' };
const accountLimit = rateLimit({ windowMs: 3600000, max: 3, keyGenerator: req => hashToken(String(req.body?.email || '').trim().toLowerCase()),
  handler: (_req, res) => res.status(202).json(generic), standardHeaders: false, legacyHeaders: false });
const emailSchema = z.object({ email: z.string().email().max(254) });
const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });
const resetSchema = tokenSchema.extend({ password: z.string().min(10).max(200), confirmation: z.string().min(10).max(200) });

router.get('/recovery-status', (_req, res) => res.json({ emailAvailable: recoveryEmailReady() }));
post('/forgot-password', requestLimit, accountLimit, async (req, res) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_email', message: '請輸入有效的 Email' });
  if (!recoveryEmailReady()) return res.status(503).json({ error: 'email_unavailable', message: '目前尚未啟用重設信件寄送，請聯絡管理員取得限時重設連結。' });
  // Respond identically before looking up an account or contacting SMTP.
  res.status(202).json(generic);
  try {
    const staff = await prisma.staff.findUnique({ where: { email: parsed.data.email } });
    if (!staff?.active || staff.pendingActivation) return;
    const link = await createRecovery(staff.id);
    const sent = await deliver(staff.email, '【重設密碼】藝術設計部專案管理', `請在 30 分鐘內開啟以下連結，自行設定新密碼：\n${link.url}\n\n此連結僅可使用一次，新要求會讓舊連結失效。若非本人申請，請忽略此信。`);
    if (!sent) await prisma.staff.updateMany({ where: { id: staff.id, resetTokenHash: link.hash }, data: { resetTokenHash: null, resetExpires: null } });
  } catch { console.warn('[recovery] Unable to deliver reset email'); }
});

post('/recovery-link/:staffId', requireAuth, requireAdmin, adminLinkLimit, async (req, res, next) => {
  try {
    const id = Number(req.params.staffId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff?.active || staff.pendingActivation) return res.status(422).json({ error: 'not_activated', message: '未啟用帳號請使用「重寄邀請」；離職帳號不可重設。' });
    const link = await createRecovery(id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url: link.url, expires: link.expires });
  } catch (error) {
    if (error.code === 'ERR_INVALID_URL' || error.message === 'invalid_app_base_url') return res.status(503).json({ error: 'base_url_unavailable', message: '請先設定 APP_BASE_URL 為本站 HTTPS 網址' });
    next(error);
  }
});

const validWhere = token => ({ resetTokenHash: hashToken(token), resetExpires: { gt: new Date() }, active: true, pendingActivation: false });
post('/reset-password/check', tokenLimit, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_token', message: '連結不完整，請重新申請重設密碼' });
  const staff = await prisma.staff.findFirst({ where: validWhere(parsed.data.token), select: { id: true } });
  res.setHeader('Cache-Control', 'no-store');
  if (!staff) return res.status(410).json({ error: 'invalid_token', message: '連結已失效、過期或已使用，請重新申請' });
  res.json({ valid: true });
});
post('/reset-password', tokenLimit, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: '請檢查連結與密碼格式' });
  const { token, password, confirmation } = parsed.data;
  if (password !== confirmation) return res.status(422).json({ error: 'mismatch', message: '兩次新密碼不一致' });
  const weak = validatePasswordStrength(password);
  if (weak) return res.status(422).json({ error: 'weak_password', message: weak });
  const staff = await prisma.staff.findFirst({ where: validWhere(token) });
  if (!staff) return res.status(410).json({ error: 'invalid_token', message: '連結已失效、過期或已使用，請重新申請' });
  if (await bcrypt.compare(password, staff.password)) return res.status(422).json({ error: 'same_as_old', message: '新密碼不可與目前密碼相同' });
  const hash = await bcrypt.hash(password, 12);
  const changed = await prisma.staff.updateMany({ where: { id: staff.id, ...validWhere(token) }, data: {
    password: hash, resetTokenHash: null, resetExpires: null, sessionVersion: { increment: 1 },
  } });
  if (!changed.count) return res.status(410).json({ error: 'invalid_token', message: '連結已使用，請重新申請' });
  clearAuthCookie(res);
  passwordChangedNotice(staff).catch(() => {});
  res.json({ ok: true, message: '密碼已更新，請使用新密碼登入。' });
});
export default router;
