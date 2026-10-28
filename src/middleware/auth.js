import jwt from 'jsonwebtoken';
import { prisma } from '../lib/db.js';
import { getJwtSecret } from '../lib/runtimeConfig.js';

export const JWT_SECRET = getJwtSecret();
const COOKIE_NAME = 'designpm_token';
// v3.6 (#22): shorter TTL — fewer days a stolen cookie is valid.
const TOKEN_TTL = '2d';

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    // v3.6 (#22): 'strict' is more secure than 'lax' but breaks normal navigation.
    // 'lax' is the right balance for a SPA with same-site auth.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 2 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// v3.6 (#22): minimum strength check used by /change-password and admin reset.
export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string') return '密碼格式錯誤';
  if (Buffer.byteLength(pw, 'utf8') > 72) return '密碼最多 72 位元組，請縮短後再試';
  if (pw.length < 10) return '密碼至少 10 字元';
  if (!/[a-z]/.test(pw)) return '密碼必須含小寫英文字母';
  if (!/[A-Z]/.test(pw)) return '密碼必須含大寫英文字母';
  if (!/\d/.test(pw))    return '密碼必須含至少一個數字';
  // Block obviously bad passwords
  const banned = ['password', '12345678', 'design2026!', 'qwertyuiop', 'admin1234'];
  if (banned.some(b => pw.toLowerCase().includes(b.toLowerCase()))) {
    return '此密碼太常見，請換一個';
  }
  return null; // ok
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// REPORTS-P2-D2: closing one's own release notice is not a business write, so observers may persist it. Exactly
// POST /api/notices/<id>/dismiss (no other path, method or notice route); the route writes for req.user only and
// enforces expectedStaffId as a precondition. Must match the global observer guard's exemption in src/index.js.
const OWN_NOTICE_DISMISS = /^\/api\/notices\/[A-Za-z0-9_-]{4,80}\/dismiss$/;
function isOwnNoticeDismissal(req) {
  return req.method === 'POST' && OWN_NOTICE_DISMISS.test(String(req.originalUrl || '').split('?')[0]);
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const staff = await prisma.staff.findUnique({ where: { id: claims.id }, select: {
      id: true, name: true, email: true, role: true, active: true, pendingActivation: true, sessionVersion: true,
    } });
    if (!staff?.active || staff.pendingActivation || (claims.sessionVersion ?? 0) !== staff.sessionVersion) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'session_expired' });
    }
    req.user = { id: staff.id, name: staff.name, email: staff.email, role: staff.role };
    // REPORTS-P3-E1b: the verified session version, re-checked inside report publication transactions.
    req.authSession = { sessionVersion: staff.sessionVersion };
    if (staff.role === 'observer' && !['GET','HEAD','OPTIONS'].includes(req.method) && !req.originalUrl.startsWith('/api/auth/')
      && !isOwnNoticeDismissal(req)) {
      return res.status(403).json({ error: 'read_only', message: '觀察者帳號為唯讀' });
    }
    next();
  } catch (error) {
    if (!['JsonWebTokenError','TokenExpiredError','NotBeforeError'].includes(error.name)) return next(error);
    clearAuthCookie(res);
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin_only' });
  }
  next();
}
