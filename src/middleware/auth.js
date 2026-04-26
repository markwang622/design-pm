import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod';
const COOKIE_NAME = 'designpm_token';
// v3.6 (#22): shorter TTL — fewer days a stolen cookie is valid.
const TOKEN_TTL = '2d';

if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'change-me-in-prod') {
  // Loud warning so an unset secret fails noisily on first deploy.
  console.error('[security] JWT_SECRET is the default value — set it in env vars NOW.');
}

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

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin_only' });
  }
  next();
}
