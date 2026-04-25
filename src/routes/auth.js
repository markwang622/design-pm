import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { signToken, setAuthCookie, clearAuthCookie, requireAuth } from '../middleware/auth.js';

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

  const staff = await prisma.staff.findUnique({ where: { id: req.user.id } });
  if (!staff) return res.status(401).json({ error: 'unauthenticated' });

  const ok = await bcrypt.compare(currentPassword, staff.password);
  if (!ok) return res.status(401).json({ error: 'wrong_current_password' });

  const hash = await bcrypt.hash(newPassword, 10);
  await prisma.staff.update({ where: { id: staff.id }, data: { password: hash } });
  res.json({ ok: true });
});

export default router;
