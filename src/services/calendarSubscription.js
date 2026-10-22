import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/db.js';

export const CALENDAR_TTL_SECONDS = 365 * 24 * 60 * 60;
const PURPOSE = 'calendar-subscription';
const ISSUER = 'design-pm';
const AUDIENCE = 'design-pm/calendar';
const KEY_CONTEXT = 'design-pm/calendar-subscription/v1';
const SCOPES = new Set(['mine', 'team']);

export class CalendarConfigurationError extends Error {
  constructor() { super('calendar_unavailable'); this.name = 'CalendarConfigurationError'; }
}

function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new CalendarConfigurationError();
  }
  // Separate key and purpose: a subscription bearer can never serve as a login JWT.
  return crypto.createHmac('sha256', secret).update(KEY_CONTEXT).digest();
}

function trustedBaseUrl() {
  try {
    const configured = process.env.APP_BASE_URL;
    if (!configured || configured !== configured.trim()) throw new Error('invalid_base');
    const base = new URL(configured);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    const localDevelopment = process.env.NODE_ENV !== 'production' && loopback;
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('invalid_base');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && localDevelopment)) throw new Error('invalid_base');
    if (loopback && !localDevelopment) throw new Error('invalid_base');
    return base;
  } catch { throw new CalendarConfigurationError(); }
}

export function calendarPrivacyHeaders(_req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

const validVersion = value => Number.isSafeInteger(value) && value >= 0;
const eligibleStaff = staff => staff?.active === true && staff.pendingActivation === false;

export function createCalendarSubscription(staff, scope = 'mine') {
  const base = trustedBaseUrl();
  const key = signingKey();
  if (!eligibleStaff(staff) || !Number.isSafeInteger(staff.id) || staff.id <= 0 || !SCOPES.has(scope)
    || !validVersion(staff.calendarVersion) || !validVersion(staff.sessionVersion)) throw new Error('invalid_calendar_identity');
  const iat = Math.floor(Date.now() / 1000);
  const token = jwt.sign({
    purpose: PURPOSE, staffId: staff.id, scope,
    calendarVersion: staff.calendarVersion, sessionVersion: staff.sessionVersion, iat,
  }, key, { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, expiresIn: CALENDAR_TTL_SECONDS });
  const url = new URL('/api/ical/calendar.ics', base);
  url.searchParams.set('token', token);
  return { url: url.href, expires: new Date((iat + CALENDAR_TTL_SECONDS) * 1000).toISOString(), scope };
}

export async function authenticateCalendarSubscription(token) {
  // Reject unbounded/structured inputs before cryptography or database access.
  if (typeof token !== 'string' || token.length < 20 || token.length > 2048) return null;
  const key = signingKey();
  let claims;
  try {
    claims = jwt.verify(token, key, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
  } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!claims || typeof claims !== 'object' || claims.purpose !== PURPOSE || !SCOPES.has(claims.scope)
    || !Number.isSafeInteger(claims.staffId) || claims.staffId <= 0
    || !validVersion(claims.calendarVersion) || !validVersion(claims.sessionVersion)
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || claims.iat > now || claims.exp <= now || claims.exp <= claims.iat
    || claims.exp - claims.iat > CALENDAR_TTL_SECONDS) return null;
  const staff = await prisma.staff.findUnique({ where: { id: claims.staffId }, select: {
    id: true, name: true, active: true, pendingActivation: true, calendarVersion: true, sessionVersion: true,
  } });
  if (!eligibleStaff(staff) || staff.calendarVersion !== claims.calendarVersion || staff.sessionVersion !== claims.sessionVersion) return null;
  return { staffId: staff.id, name: staff.name, scope: claims.scope };
}
