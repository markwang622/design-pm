// Isolated HTTP security tests: synthetic users/tokens; no database, SMTP or external HTTP.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
const secret = 'synthetic-calendar-test-secret-at-least-32-bytes';
process.env.JWT_SECRET = secret;
process.env.APP_BASE_URL = 'https://calendar.fixture.invalid';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/never_connect';
process.env.ICAL_KEY = 'configured-legacy-fixture-key';
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const { CALENDAR_TTL_SECONDS } = await import(root + '/src/services/calendarSubscription.js');
const users = new Map([
  [1, { id: 1, name: 'Fixture Person', role: 'member' }],
  [2, { id: 2, name: 'Fixture Person', role: 'observer' }],
  [3, { id: 3, name: 'Fixture Admin', role: 'admin' }],
].map(([id, s]) => [id, { ...s, active: true, pendingActivation: false, calendarVersion: 0, sessionVersion: 0, password: 'not-a-real-password', activatedAt: null }]));
let dbReads = 0, businessReads = 0, writes = 0, failBusiness = false;
const readArgs = [];
const day = new Date('2026-10-22');
const fixtures = {
  case: [
    { id: 'OWN', title: 'OWN_CASE', goLiveDate: day, designerId: 1, collaborators: [] },
    { id: 'COLLAB', title: 'COLLAB_CASE', goLiveDate: day, designerId: 2, collaborators: [{ id: 1 }] },
    { id: 'OTHER', title: 'OTHER_CASE', goLiveDate: day, designerId: 2, collaborators: [] },
  ],
  shoot: [
    { id: 1, desc: 'OWN_SHOOT', mode: 'in-house', startDate: day, endDate: day, createdById: 1, photographer: '' },
    { id: 2, desc: 'OTHER_SHOOT', mode: 'in-house', startDate: day, endDate: day, createdById: 2, photographer: 'Fixture Person' },
  ],
  vacation: [1, 2].map(id => ({ id, staffId: id, staff: { name: 'VACATION_' + id }, type: 'annual', startDate: day, endDate: day })),
  businessTrip: [1, 2].map(id => ({ id, staffId: id, staff: { name: 'TRIP_' + id }, hotel: 'Fixture hotel', startDate: day, endDate: day })),
  meeting: [
    { id: 1, title: 'HOST_MEETING', hostId: 1, attendees: [], date: day, startTime: '10:00', endTime: '11:00' },
    { id: 2, title: 'ATTEND_MEETING', hostId: 2, attendees: [{ staffId: 1 }], date: day, startTime: '10:00', endTime: '11:00' },
    { id: 3, title: 'OTHER_MEETING', hostId: 2, attendees: [{ staffId: 2 }], date: day, startTime: '10:00', endTime: '11:00' },
  ],
};
for (const name of ['staff', 'case', 'shoot', 'vacation', 'businessTrip', 'meeting', 'notification']) {
  for (const method of ['findUnique', 'findFirst', 'findMany', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany']) {
    prisma[name][method] = async () => { throw Error('Unexpected model access blocked: ' + name + '.' + method); };
  }
}
prisma.staff.findUnique = async ({ where }) => { dbReads++; const s = users.get(where.id); return s ? { ...s } : null; };
prisma.staff.updateMany = async ({ where, data }) => {
  const s = users.get(where.id);
  assert.deepEqual(data, { calendarVersion: { increment: 1 } }, 'revoke can only change calendarVersion');
  if (!s || !Object.entries(where).every(([k, v]) => s[k] === v)) return { count: 0 };
  s.calendarVersion += data.calendarVersion.increment; writes++; return { count: 1 };
};
for (const [name, rows] of Object.entries(fixtures)) {
  prisma[name].findMany = async args => {
    dbReads++; businessReads++; readArgs.push({ name, args });
    if (failBusiness) throw Error('synthetic business read fault');
    // Return all fixture rows, so tests verify both query restrictions and final ID checks.
    return structuredClone(rows);
  };
}
const auth = (await import(root + '/src/routes/auth.js')).default;
const ical = (await import(root + '/src/routes/ical.js')).default;
const app = express();
app.use(express.json(), cookieParser());
app.use('/api/auth', auth); // Same mount order as the app: observers may manage their own subscription.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(403).json({ error: 'read_only' });
  next();
});
app.use('/api/ical', ical);
app.use((e, _req, res, _next) => res.status(e.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'test_error' }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const cookie = id => 'designpm_token=' + signToken({ id, role: users.get(id).role, sessionVersion: users.get(id).sessionVersion });
async function call(path, { method = 'GET', body, authCookie, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(authCookie ? { Cookie: authCookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, text, data, headers: response.headers };
}
const management = '/api/auth/calendar-subscription';
const feed = token => '/api/ical/calendar.ics?token=' + encodeURIComponent(token);
async function issue(id = 1, scope = 'mine') {
  const r = await call(management + '?scope=' + scope, { authCookie: cookie(id) });
  assert.equal(r.status, 200, r.text);
  return { ...r.data, token: new URL(r.data.url).searchParams.get('token') };
}
const derivedKey = crypto.createHmac('sha256', secret).update('design-pm/calendar-subscription/v1').digest();
function signedFixture(overrides = {}, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ purpose: 'calendar-subscription', staffId: 1, scope: 'mine', calendarVersion: users.get(1).calendarVersion, sessionVersion: users.get(1).sessionVersion, iat: now, exp: now + 3600, ...overrides }, derivedKey, { algorithm: 'HS256', issuer: 'design-pm', audience: 'design-pm/calendar', ...options });
}
function privacy(r) { assert.match(r.headers.get('cache-control'), /no-store/); assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); }
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
try {
  await test('legacy public/configured keys and anonymous feed fail before any database reads', async () => {
    for (const query of ['', '?key=design-pm-cal', '?key=configured-legacy-fixture-key', '?key=', '?scope=team', '?token[]=bad']) {
      const before = dbReads; const r = await call('/api/ical/calendar.ics' + query);
      assert.equal(r.status, 403); assert.equal(dbReads, before); privacy(r);
    }
  });
  await test('anonymous issue and revoke return 401 without model reads', async () => {
    for (const options of [{}, { method: 'POST', body: {} }]) {
      const before = dbReads; const r = await call(management + (options.method ? '/revoke' : ''), options);
      assert.equal(r.status, 401); assert.equal(dbReads, before); privacy(r);
    }
  });
  let mine;
  await test('authenticated issuance is a read-only trusted-origin URL with bounded claims', async () => {
    const before = writes;
    const r = await call(management, { authCookie: cookie(1), headers: { Host: 'attacker.fixture.invalid', 'X-Forwarded-Host': 'attacker.fixture.invalid', 'X-Forwarded-Proto': 'http' } });
    assert.equal(r.status, 200); privacy(r); assert.equal(writes, before);
    assert.deepEqual(Object.keys(r.data).sort(), ['expires', 'scope', 'url']);
    assert.equal(new URL(r.data.url).origin, 'https://calendar.fixture.invalid');
    mine = new URL(r.data.url).searchParams.get('token'); const c = jwt.decode(mine);
    assert.equal(c.purpose, 'calendar-subscription'); assert.equal(c.staffId, 1); assert.equal(c.scope, 'mine');
    assert.equal(c.calendarVersion, 0); assert.equal(c.sessionVersion, 0); assert.equal(c.exp - c.iat, CALENDAR_TTL_SECONDS);
    assert.equal(new Date(r.data.expires).getTime(), c.exp * 1000); assert(!('id' in c));
  });
  await test('mine filters all five resources by ID; equal names and photographer text do not widen it', async () => {
    readArgs.length = 0; const r = await call(feed(mine)); assert.equal(r.status, 200); privacy(r);
    for (const expected of ['OWN_CASE', 'COLLAB_CASE', 'OWN_SHOOT', 'VACATION_1', 'TRIP_1', 'HOST_MEETING', 'ATTEND_MEETING']) assert(r.text.includes(expected), expected);
    for (const forbidden of ['OTHER_CASE', 'OTHER_SHOOT', 'VACATION_2', 'TRIP_2', 'OTHER_MEETING']) assert(!r.text.includes(forbidden), forbidden);
    assert(readArgs.every(r => Object.keys(r.args.where).length > 0));
    assert.deepEqual(readArgs.find(r => r.name === 'vacation').args.where, { staffId: 1 });
    assert.deepEqual(readArgs.find(r => r.name === 'shoot').args.where, { createdById: 1 });
    assert(readArgs.find(r => r.name === 'case').args.where.OR.some(w => w.collaborators?.some?.id === 1));
    assert(readArgs.find(r => r.name === 'meeting').args.where.OR.some(w => w.attendees?.some?.staffId === 1));
  });
  await test('query overrides and duplicate token parameters fail before any database reads', async () => {
    for (const extra of ['&scope=team', '&staff=Fixture%20Admin', '&staffId=3', '&key=configured-legacy-fixture-key', '&token=duplicate']) {
      const before = dbReads; assert.equal((await call(feed(mine) + extra)).status, 403); assert.equal(dbReads, before);
    }
  });
  await test('current staff name is display-only and is escaped in calendar metadata', async () => {
    users.get(1).name = 'Renamed\r\nBEGIN:VEVENT';
    const r = await call(feed(mine)); assert.equal(r.status, 200); assert(r.text.includes('Renamed\\nBEGIN:VEVENT'));
    assert(r.text.includes('OWN_CASE')); users.get(1).name = 'Fixture Person';
  });
  await test('team is available to each authenticated role and includes team events', async () => {
    for (const id of [1, 2, 3]) {
      const grant = await issue(id, 'team'); const r = await call(feed(grant.token));
      assert.equal(r.status, 200); assert(r.text.includes('OTHER_CASE')); assert(r.text.includes('OTHER_MEETING'));
    }
  });
  await test('calendar token cannot authenticate as a login cookie', async () => {
    assert.throws(() => jwt.verify(mine, secret));
    const before = dbReads; const r = await call('/api/auth/me', { authCookie: 'designpm_token=' + mine });
    assert.equal(r.status, 401); assert.equal(dbReads, before);
  });
  await test('login JWT cannot authenticate as a subscription', async () => {
    const before = dbReads; const r = await call(feed(signToken({ id: 1, role: 'admin', sessionVersion: 0 })));
    assert.equal(r.status, 403); assert.equal(dbReads, before);
  });
  await test('tampered token signature fails before any database reads', async () => {
    const parts = mine.split('.'); const payload = JSON.parse(Buffer.from(parts[1], 'base64url')); payload.scope = 'team';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url'); const before = dbReads;
    assert.equal((await call(feed(parts.join('.')))).status, 403); assert.equal(dbReads, before);
  });
  await test('expiry, purpose, scope, versions, algorithm and lifetime are strictly validated before model reads', async () => {
    const now = Math.floor(Date.now() / 1000);
    // iat is pinned to the same `now`: signedFixture's own clock read may cross a second, which would turn
    // this over-TTL fixture into a valid exactly-TTL token.
    const overLifetime = signedFixture({ iat: now, exp: now + CALENDAR_TTL_SECONDS + 1 });
    const lifetime = jwt.decode(overLifetime); assert.equal(lifetime.exp - lifetime.iat, CALENDAR_TTL_SECONDS + 1);
    const invalid = [signedFixture({ iat: now - 100, exp: now - 1 }), signedFixture({ purpose: 'login' }), signedFixture({ scope: 'all' }), signedFixture({ staffId: '1' }), signedFixture({ calendarVersion: -1 }), signedFixture({ sessionVersion: 1.5 }), signedFixture({ iat: now + 60, exp: now + 120 }), overLifetime, signedFixture({}, { algorithm: 'HS384' }), signedFixture({}, { noTimestamp: true })];
    for (const token of invalid) { const before = dbReads; assert.equal((await call(feed(token))).status, 403); assert.equal(dbReads, before); }
  });
  await test('inactive, unactivated or deleted subscriber fails before business reads', async () => {
    for (const patch of [{ active: false }, { pendingActivation: true }]) {
      const saved = { ...users.get(1) }; Object.assign(users.get(1), patch); const before = businessReads;
      assert.equal((await call(feed(mine))).status, 403); assert.equal(businessReads, before); users.set(1, saved);
    }
    const saved = users.get(1); users.delete(1); const before = businessReads;
    assert.equal((await call(feed(mine))).status, 403); assert.equal(businessReads, before); users.set(1, saved);
  });
  await test('session revocation invalidates subscriptions before business reads', async () => {
    users.get(1).sessionVersion++; const before = businessReads;
    assert.equal((await call(feed(mine))).status, 403); assert.equal(businessReads, before);
    mine = (await issue()).token; assert.equal((await call(feed(mine))).status, 200);
  });
  await test('own revoke is atomic, invalidates both scopes and does not mutate password/session/other users', async () => {
    const team = (await issue(1, 'team')).token; const before = structuredClone([...users]);
    const r = await call(management + '/revoke', { method: 'POST', body: {}, authCookie: cookie(1) });
    assert.equal(r.status, 200); assert.deepEqual(r.data, { ok: true }); privacy(r);
    for (const [id, saved] of before) assert.deepEqual(users.get(id), { ...saved, calendarVersion: saved.calendarVersion + (id === 1 ? 1 : 0) });
    const reads = businessReads; assert.equal((await call(feed(mine))).status, 403); assert.equal((await call(feed(team))).status, 403); assert.equal(businessReads, reads);
    assert.equal((await call('/api/auth/me', { authCookie: cookie(1) })).status, 200);
    mine = (await issue()).token; assert.equal((await call(feed(mine))).status, 200);
  });
  await test('observer may issue and revoke only its own token', async () => {
    const grant = await issue(2); const other = users.get(1).calendarVersion;
    const r = await call(management + '/revoke', { method: 'POST', authCookie: cookie(2) });
    assert.equal(r.status, 200); assert.equal(users.get(1).calendarVersion, other); assert.equal((await call(feed(grant.token))).status, 403);
    assert.equal((await call(feed((await issue(2)).token))).status, 200);
  });
  await test('concurrent revocation increments without lost updates', async () => {
    const before = users.get(2).calendarVersion;
    const results = await Promise.all([1, 2].map(() => call(management + '/revoke', { method: 'POST', body: {}, authCookie: cookie(2) })));
    assert(results.every(r => r.status === 200)); assert.equal(users.get(2).calendarVersion, before + 2);
  });
  await test('management rejects malformed scope and all arbitrary staff selectors without writes', async () => {
    const before = writes;
    for (const query of ['?scope=all', '?scope=', '?scope[]=mine', '?scope=mine&scope=team', '?staffId=2', '?scope=mine&staff=other']) assert.equal((await call(management + query, { authCookie: cookie(1) })).status, 400);
    for (const body of [{ staffId: 2 }, { calendarVersion: 0 }, [], null, 'bad']) assert.equal((await call(management + '/revoke', { method: 'POST', body, authCookie: cookie(1) })).status, 400);
    assert.equal((await call(management + '/revoke?staffId=2', { method: 'POST', body: {}, authCookie: cookie(1) })).status, 400);
    assert.equal(writes, before);
  });
  await test('missing or unsafe configured base fails closed without trusting request headers', async () => {
    for (const value of [undefined, '', 'not a url', 'http://unsafe.fixture.invalid', 'ftp://localhost', 'https://user:pass@example.test', 'https://example.test/?x=1', 'https://example.test/#fragment', 'https://example.test/subpath']) {
      if (value === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = value;
      const r = await call(management, { authCookie: cookie(1), headers: { Host: 'safe.fixture.invalid' } });
      assert.equal(r.status, 503, String(value)); assert.equal(r.data.error, 'calendar_unavailable'); privacy(r);
    }
    process.env.APP_BASE_URL = 'https://calendar.fixture.invalid';
  });
  await test('localhost HTTP is development-only', async () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';
    const dev = await issue(); assert.equal(new URL(dev.url).origin, 'http://localhost:3000');
    process.env.NODE_ENV = 'production'; assert.equal((await call(management, { authCookie: cookie(1) })).status, 503);
    process.env.NODE_ENV = 'test'; process.env.APP_BASE_URL = 'https://calendar.fixture.invalid';
  });
  await test('missing and weak signing secrets yield bounded unavailable responses and no business access', async () => {
    for (const value of [undefined, '', 'short', ' '.repeat(40)]) {
      if (value === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = value;
      const before = businessReads;
      assert.equal((await call(management, { authCookie: cookie(1) })).status, 503);
      assert.equal((await call(feed(mine))).status, 503); assert.equal(businessReads, before);
    }
    process.env.JWT_SECRET = secret;
  });
  await test('malformed feed inputs fail without any database reads', async () => {
    for (const token of ['', 'no-token', 'a'.repeat(2050), 'a.b.c', '{}']) {
      const before = dbReads; const r = await call(feed(token)); assert.equal(r.status, 403); assert.equal(dbReads, before); privacy(r);
    }
  });
  await test('valid-token business read failure stays bounded and retains privacy headers', async () => {
    mine = (await issue()).token; failBusiness = true;
    const r = await call(feed(mine)); assert.equal(r.status, 500); assert(!r.text.includes('synthetic')); privacy(r); failBusiness = false;
    assert.equal((await call(feed(mine))).status, 200);
  });
  console.log(JSON.stringify({ passed, liveDatabase: false, externalHTTP: false, emailSent: false, realCredentials: false }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); }
