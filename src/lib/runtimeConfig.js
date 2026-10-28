// Pure configuration checks shared by the server and maintenance entrypoints.
// Errors name the setting to fix and never include its value or credentials.
export class ConfigurationError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'ConfigurationError';
    this.code = 'unsafe_configuration';
    this.field = field;
  }
}
const fail = (field, message) => { throw new ConfigurationError(field, message); };
const DEVELOPMENT_SECRET = 'development-only-local-secret-do-not-use-in-production';
const PLACEHOLDER_SECRET = /^(change-me-in-prod|replace[-_ ]?me|your[-_ ].*secret|development-only-local-secret)/i;

export function getJwtSecret(env = process.env) {
  if (env.NODE_ENV !== undefined && !['production', 'development', 'test'].includes(env.NODE_ENV)) {
    fail('NODE_ENV', 'use production, development or test; unrecognized modes cannot bypass production checks');
  }
  const secret = env.JWT_SECRET;
  if (env.NODE_ENV === 'production') {
    if (typeof secret !== 'string' || secret !== secret.trim() || Buffer.byteLength(secret, 'utf8') < 32 || PLACEHOLDER_SECRET.test(secret)) {
      fail('JWT_SECRET', 'set a random secret of at least 32 bytes before starting production; keep the existing secure secret during upgrades');
    }
  }
  return secret || DEVELOPMENT_SECRET;
}

export function validatePostgresUrl(value, { required = true } = {}) {
  if (!value && !required) return undefined;
  try {
    if (typeof value !== 'string' || value !== value.trim()) throw Error();
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash) throw Error();
    return value;
  } catch {
    fail('DATABASE_URL', 'set a PostgreSQL connection URL with a host and database name; credentials are never printed');
  }
}

function validateOrigin(value, production) {
  if (!value && !production) return undefined;
  try {
    if (typeof value !== 'string' || value !== value.trim()) throw Error();
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production && loopback)) throw Error();
    if (production && loopback) throw Error();
    return url.origin;
  } catch {
    fail('APP_BASE_URL', 'set the trusted HTTPS application origin without credentials, path, query or fragment (loopback HTTP is development-only)');
  }
}

export function validateRuntimeConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const jwtSecret = getJwtSecret(env);
  const databaseUrl = validatePostgresUrl(env.DATABASE_URL, { required: production });
  const appBaseUrl = validateOrigin(env.APP_BASE_URL, production);
  const rawPort = env.PORT === undefined ? '3000' : String(env.PORT);
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail('PORT', 'set an integer from 1 to 65535');
  }
  const workReportScheduler = validateWorkReportScheduler(env);
  return Object.freeze({ production, jwtSecret, databaseUrl, appBaseUrl, port, workReportScheduler });
}

// REPORTS-P3-E3: automatic initial work reports. Off unless exactly "true"; enabling requires an explicit real start date
// (the first enabled run persists it as the lower bound; only periods due on/after it are scheduled).
export function validateWorkReportScheduler(env = process.env) {
  const flag = env.WORK_REPORT_SCHEDULER_ENABLED;
  if (flag !== undefined && flag !== 'true' && flag !== 'false') fail('WORK_REPORT_SCHEDULER_ENABLED', 'use true or false (unset means false)');
  const raw = env.WORK_REPORT_SCHEDULER_START_DATE;
  let startDate = null;
  if (raw !== undefined && raw !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const t = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    if (!m || +m[1] < 2000 || +m[1] > 2100 || t.getUTCMonth() !== +m[2] - 1 || t.getUTCDate() !== +m[3]) fail('WORK_REPORT_SCHEDULER_START_DATE', 'use a real Asia/Taipei calendar date YYYY-MM-DD');
    startDate = raw;
  }
  const enabled = flag === 'true';
  if (enabled && !startDate) fail('WORK_REPORT_SCHEDULER_START_DATE', 'set the first scheduled date explicitly before enabling the scheduler');
  return Object.freeze({ enabled, startDate });
}

export function validateOperatorPassword(value, field = 'SEED_ADMIN_PASSWORD') {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 72 || value.length < 12
    || !/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)
    || /password|design2026|demo2026test|qwerty|admin1234/i.test(value)) {
    fail(field, 'set an explicit password of 12 or more characters with uppercase, lowercase and a number, at most 72 UTF-8 bytes; shared sample/default passwords are refused');
  }
  return value;
}
