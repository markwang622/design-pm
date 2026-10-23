// ─────────────────────────────────────────────────────────────
// Design-PM — Express entry (single service: API + static SPA)
// ─────────────────────────────────────────────────────────────
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { privateRequestUrl } from './lib/requestPrivacy.js';
import { validateRuntimeConfig } from './lib/runtimeConfig.js';
import { JWT_SECRET } from './middleware/auth.js';
import { fileURLToPath } from 'node:url';

import authRouter from './routes/auth.js';
import casesRouter from './routes/cases.js';
import staffRouter from './routes/staff.js';
import notifRouter from './routes/notifications.js';
import analyticsRouter from './routes/analytics.js';
import hotelsRouter from './routes/hotels.js';
import unitsRouter from './routes/units.js'; // v4.7
import vacationsRouter from './routes/vacations.js';
import businessTripsRouter from './routes/businessTrips.js';
import shootsRouter from './routes/shoots.js'; // G2
import meetingsRouter from './routes/meetings.js'; // v6.0
import icalRouter from './routes/ical.js'; // J2
import adminRouter from './routes/admin.js';
import demoDataRouter from './routes/demoData.js'; // v9.4 暫用：正式→Demo 資料複製（僅 demo 站啟用）
import { startMeetingReminderLoop } from './services/meetingReminders.js'; // M3

// Validate before opening a listener or starting any background database work.
const runtimeConfig = validateRuntimeConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();

// Security / basics
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Zeabur's proxy
// Explicit CSP (instead of helmet's default strict mode).
// We override any upstream proxy CSP. SPA uses inline scripts and
// inline event handlers, so 'unsafe-inline' is required for script-src
// and style-src. 'unsafe-eval' is included defensively for any future
// dynamic-template usage and to silence Chrome DevTools warnings.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        scriptSrcAttr: ["'unsafe-inline'"], // for inline onclick="…"
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"], // anti-clickjacking
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // v3.6 (#22): force HTTPS for 6 months in browsers (production only)
    strictTransportSecurity: process.env.NODE_ENV === 'production'
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
// v3.6 (#22): tighter CORS — only same-origin in production. Dev permissive.
app.use(cors(
  process.env.NODE_ENV === 'production'
    ? { credentials: true, origin: true } // browsers ignore credentials with origin: '*', so 'true' echos request origin
    : { credentials: true, origin: true }
));
morgan.token('url', req => privateRequestUrl(req.originalUrl || req.url));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Health check (Zeabur pings this)
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// (v3.6 #22) Login throttle: tighter limit per IP. 10 failed attempts /
// 15 min causes 429. /api/auth/me and /logout are excluded so a logged-in
// user can refresh freely.
const loginThrottle = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_login_attempts', message: '登入嘗試過於頻繁，請 15 分鐘後再試' },
  skip: (req) => {
    // Throttle only the credential-checking POST /login + /change-password
    // v7.3: 只把「會設定密碼」的 POST /activate 納入嚴格節流。
    // GET /activation/:token 僅做連結有效性檢查，token 有 256 bits 熵，暴力猜測
    // 不可行；把它放進這個 15 分鐘 10 次的桶子只會讓共用對外 IP 的辦公室互相
    // 卡住（它與 /login 共用配額），因此改由較寬鬆的 authLimiter 承接。
    return !(/\/login$|\/change-password$|\/activate$|\/reset-password$/.test(req.path));
  },
});
// General auth limiter (covers /me, /logout): looser
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth', loginThrottle, authLimiter, authRouter);

// (v3.6 #22) Global API rate limit — defense against brute scraping.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// 觀察者（observer）角色：唯讀。擋掉所有非 GET 的 API 寫入（auth 流程除外）。
// 真正的權限防線在伺服器端——前端只是不顯示編輯入口。
import jwtGuard from 'jsonwebtoken';
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/auth')) return next(); // 登入/登出/改密碼/me
  const token = req.cookies?.designpm_token;
  if (token) {
    try {
      const u = jwtGuard.verify(token, JWT_SECRET);
      if (u.role === 'observer') {
        return res.status(403).json({ error: 'read_only', message: '觀察者帳號為唯讀，無法執行此操作。' });
      }
    } catch { /* token 無效 → 交由下游 requireAuth 處理 */ }
  }
  next();
});

// Main API
app.use('/api/cases', casesRouter);
app.use('/api/staff', staffRouter);
app.use('/api/notifications', notifRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/hotels', hotelsRouter);
app.use('/api/units', unitsRouter); // v4.7
app.use('/api/vacations', vacationsRouter);
app.use('/api/business-trips', businessTripsRouter);
app.use('/api/shoots', shootsRouter); // G2
app.use('/api/meetings', meetingsRouter); // v6.0
app.use('/api/ical', icalRouter); // J2（免登入，?key= 驗證）
app.use('/api/admin', adminRouter);
app.use('/api/admin/demo-data', demoDataRouter); // APP_BASE_URL !== demo 站時整組 404

// 404 for unknown API paths
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Static frontend.
// HTML files: never cache (so deploys take effect immediately).
// Other static (favicon etc.): 1h cache.
const noCacheHtml = (res, filePath) => {
  if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
};

app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: '1h',
    index: false,
    setHeaders: noCacheHtml,
  })
);

const sendNoCacheHtml = (res, file) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(file);
};

// (v3.7 #安全) Server-side auth gate for the SPA shell.
// Before v3.7: index.html was served to anyone, then JS would fetch /me,
// see 401, and redirect. The user briefly saw the (data-less) main shell.
// Now: if no valid cookie, send 302 → /login WITHOUT touching index.html.
import jwt from 'jsonwebtoken';
function isAuthed(req) {
  const token = req.cookies?.designpm_token;
  if (!token) return false;
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

// Un-authenticated login page (always accessible)
app.get('/login', (_req, res) => {
  // A signed cookie can belong to a removed or revoked account. Keep sign-in
  // reachable even before an API response has cleared that stale cookie.
  sendNoCacheHtml(res, path.join(PUBLIC_DIR, 'login.html'));
});

// v7.3: 邀請啟用頁（設定首次密碼）——尚未有帳號密碼，必須免登入可存取
app.get('/activate', (req, res) => {
  sendNoCacheHtml(res, path.join(PUBLIC_DIR, 'activate.html'));
});

// SPA shell — gated. /change-password, /reports, etc. all need auth.
app.get('*', (req, res) => {
  if (!isAuthed(req)) {
    return res.redirect(302, '/login');
  }
  sendNoCacheHtml(res, path.join(PUBLIC_DIR, 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  // v9.6: 已開始回應就交回 Express 預設處理，避免二次寫入 header
  if (res.headersSent) return next(err);
  // body-parser：JSON 語法錯誤 / 過大
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: '請求內容不是有效的 JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: '請求內容過大' });
  // Prisma 常見可預期錯誤 → 不洩漏細節的明確狀態碼
  if (err && err.code === 'P2025') return res.status(404).json({ error: 'not_found' });
  if (err && err.code === 'P2002') return res.status(409).json({ error: 'duplicate' });
  if (err && /PrismaClientValidationError/.test(err.name || '')) return res.status(400).json({ error: 'invalid_request' });
  // 其餘：伺服器端完整紀錄，對外只給代碼，不帶 stack / DB 訊息
  console.error('[err]', req.method, privateRequestUrl(req.originalUrl), err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'server_error' });
});

const PORT = runtimeConfig.port;
app.listen(PORT, () => {
  console.log(`[design-pm] listening on :${PORT}`);
  startMeetingReminderLoop(); // M3: 會前提醒排程
});
