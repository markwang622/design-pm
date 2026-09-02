import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { signToken, setAuthCookie, clearAuthCookie, requireAuth, validatePasswordStrength } from '../middleware/auth.js';
import { hashToken } from '../lib/activation.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { email, password } = parsed.data;

  const staff = await prisma.staff.findUnique({ where: { email } });
  if (!staff || !staff.active) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  // v7.3: 邀請建立但尚未啟用的帳號，任何密碼都不得登入
  if (staff.pendingActivation) {
    return res.status(403).json({
      error: 'pending_activation',
      message: '此帳號尚未啟用。請使用管理員提供的「設定密碼」連結完成啟用；連結遺失或過期請聯絡管理員重新產生。',
    });
  }
  const ok = await bcrypt.compare(password, staff.password);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signToken({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    role: staff.role,
  });
  setAuthCookie(res, token);
  res.json({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    role: staff.role,
    seniority: staff.seniority,
  });
});

// ─── GET /api/auth/activation/:token — 檢查連結是否有效 (v7.3) ──
// 給啟用頁在載入時判斷要顯示表單還是「連結已失效」。只回傳姓名/Email，
// 不回傳任何其他個資。
router.get('/activation/:token', async (req, res) => {
  const staff = await prisma.staff.findFirst({
    where: { activationTokenHash: hashToken(req.params.token), pendingActivation: true },
    select: { name: true, email: true, activationExpires: true, active: true },
  });
  if (!staff || !staff.active) return res.status(404).json({ error: 'invalid_token', message: '連結無效或已被使用' });
  if (staff.activationExpires && staff.activationExpires < new Date()) {
    return res.status(410).json({ error: 'expired', message: '連結已過期，請聯絡管理員重新產生' });
  }
  res.json({ name: staff.name, email: staff.email, expires: staff.activationExpires });
});

// ─── POST /api/auth/activate — 首次設定密碼並啟用 (v7.3) ─────
// 成功後 token 立即作廢（單次使用），並直接發登入 cookie。
const activateSchema = z.object({
  token: z.string().min(32).max(200),
  password: z.string().min(8).max(200),
});
router.post('/activate', async (req, res) => {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { token, password } = parsed.data;

  const staff = await prisma.staff.findFirst({
    where: { activationTokenHash: hashToken(token), pendingActivation: true },
  });
  if (!staff || !staff.active) return res.status(404).json({ error: 'invalid_token', message: '連結無效或已被使用' });
  if (staff.activationExpires && staff.activationExpires < new Date()) {
    return res.status(410).json({ error: 'expired', message: '連結已過期，請聯絡管理員重新產生' });
  }
  const strengthErr = validatePasswordStrength(password);
  if (strengthErr) return res.status(422).json({ error: 'weak_password', message: strengthErr });

  const updated = await prisma.staff.update({
    where: { id: staff.id },
    data: {
      password: await bcrypt.hash(password, 12),
      pendingActivation: false,
      activationTokenHash: null,   // 單次使用：立即作廢
      activationExpires: null,
      activatedAt: new Date(),
    },
  });
  const jwtToken = signToken({ id: updated.id, name: updated.name, email: updated.email, role: updated.role });
  setAuthCookie(res, jwtToken);
  res.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, seniority: updated.seniority });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const staff = await prisma.staff.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true, email: true, role: true, seniority: true, active: true },
  });
  if (!staff || !staff.active) return res.status(401).json({ error: 'unauthenticated' });
  res.json(staff);
});

const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post('/change-password', requireAuth, async (req, res) => {
  const parsed = changePwSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { currentPassword, newPassword } = parsed.data;

  // v3.6 (#22): server-side strength check
  const strengthErr = validatePasswordStrength(newPassword);
  if (strengthErr) {
    return res.status(422).json({ error: 'weak_password', message: strengthErr });
  }
  if (newPassword === currentPassword) {
    return res.status(422).json({ error: 'same_as_old', message: '新密碼不能跟舊密碼一樣' });
  }

  const staff = await prisma.staff.findUnique({ where: { id: req.user.id } });
  if (!staff) return res.status(401).json({ error: 'unauthenticated' });

  const ok = await bcrypt.compare(currentPassword, staff.password);
  if (!ok) return res.status(401).json({ error: 'wrong_current_password' });

  const hash = await bcrypt.hash(newPassword, 12); // v3.6: 10 → 12 rounds
  await prisma.staff.update({ where: { id: staff.id }, data: { password: hash } });
  res.json({ ok: true });
});

export default router;
