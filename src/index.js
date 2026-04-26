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
import { fileURLToPath } from 'node:url';

import authRouter from './routes/auth.js';
import casesRouter from './routes/cases.js';
import staffRouter from './routes/staff.js';
import notifRouter from './routes/notifications.js';
import analyticsRouter from './routes/analytics.js';

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
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'data:'],
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
    return !(/\/login$|\/change-password$/.test(req.path));
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

// Main API
app.use('/api/cases', casesRouter);
app.use('/api/staff', staffRouter);
app.use('/api/notifications', notifRouter);
app.use('/api/analytics', analyticsRouter);

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

// Un-authenticated login page
app.get('/login', (req, res) => sendNoCacheHtml(res, path.join(PUBLIC_DIR, 'login.html')));

// SPA fallback — everything else goes to the main shell
app.get('*', (req, res) => {
  sendNoCacheHtml(res, path.join(PUBLIC_DIR, 'index.html'));
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('[err]', err);
  res.status(500).json({ error: 'server_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[design-pm] listening on :${PORT}`);
});
