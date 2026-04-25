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
app.use(
  helmet({
    contentSecurityPolicy: false, // SPA uses inline styles/scripts
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors({ credentials: true, origin: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Health check (Zeabur pings this)
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Auth routes: extra rate-limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth', authLimiter, authRouter);

// Main API
app.use('/api/cases', casesRouter);
app.use('/api/staff', staffRouter);
app.use('/api/notifications', notifRouter);
app.use('/api/analytics', analyticsRouter);

// 404 for unknown API paths
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Static frontend
app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: '1h',
    index: false, // we handle index manually so we can serve login.html
  })
);

// Un-authenticated login page
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

// SPA fallback — everything else goes to the main shell
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
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
