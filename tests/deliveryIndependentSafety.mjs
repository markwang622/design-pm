// Codex independent acceptance against real Express routes and disposable PG18.
// This runner creates/drops only its own explicitly labelled local fixture DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.RUN_ISOLATED_DELIVERY_TEST !== '1') throw Error('Explicit isolated-test opt-in required');
const root = process.env.DESIGN_PM_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const container = process.env.DESIGN_PM_PG_TEST_CONTAINER || 'codex-design-pm-phase4-pg18';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const [info] = JSON.parse(docker('inspect', container));
assert.equal(info.Config.Labels?.['codex.task'], 'design-pm-phase3', 'fixture label required');
assert.equal(info.Config.Labels?.['codex.fixture'], 'phase4-pg18', 'PG18 fixture required');
assert.equal(info.State.Running, true);
const bindings = info.NetworkSettings.Ports['5432/tcp'];
assert(bindings?.length && bindings.every(p => p.HostIp === '127.0.0.1'), 'loopback-only fixture required');
const settings = Object.fromEntries(info.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const username = settings.POSTGRES_USER || 'postgres';
const dbName = `design_pm_delivery_acceptance_${Date.now()}_${process.pid}`;
assert.match(dbName, /^design_pm_delivery_acceptance_\d+_\d+$/);
const dbUrl = new URL(`postgresql://127.0.0.1:${bindings[0].HostPort}/${dbName}`);
dbUrl.username = username;
dbUrl.password = settings.POSTGRES_PASSWORD || '';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-delivery-acceptance-signing-secret';
process.env.DATABASE_URL = dbUrl.href;
delete process.env.DELIVERY_RECORDS_ENABLED;
for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_')) delete process.env[key];

let prisma, made = false, passed = 0;
const results = [];
const day = s => new Date(s + 'T00:00:00Z');
async function test(name, run) {
  if (process.env.DELIVERY_TEST_FILTER && !name.includes(process.env.DELIVERY_TEST_FILTER)) return;
  await run(); passed++; results.push(name); console.log('PASS ' + name);
}

try {
  docker('exec', container, 'createdb', '-U', username, dbName); made = true;
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  ({ prisma } = await import(path.join(root, 'src/lib/db.js')));
  const history = await prisma.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');
  assert(history.some(m => m.migration_name.startsWith('0003_')), 'reviewed additive delivery migration required');
  const people = {};
  for (const [key, role] of [['admin','admin'],['owner','member'],['collab','member'],['other','member'],['observer','observer']]) {
    people[key] = await prisma.staff.create({ data: {
      name: `Acceptance ${key}`, email: `${key}@delivery-fixture.invalid`,
      password: 'unusable-isolated-fixture-value', role, joined: day('2026-10-01'), seniority: 'mid',
    } });
  }
  const { signToken } = await import(path.join(root, 'src/middleware/auth.js'));
  const { default: express } = await import('express');
  const { default: cookieParser } = await import('cookie-parser');
  const app = express(); app.use(cookieParser());
  app.use('/api/cases', (await import(path.join(root, 'src/routes/cases.js'))).default);
  app.use((error, req, res, next) => { res.status(500).json({ error: 'independent_test_server_error', code: error.code || null }); });
  function call(suffix, method = 'GET', body = {}, actor = 'owner') {
    return new Promise((resolve, reject) => {
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
      const req = new http.IncomingMessage(socket); req.url = '/api/cases/' + suffix; req.method = method;
      req.headers = { cookie: 'designpm_token=' + signToken(people[actor]), 'content-type': 'application/json' }; req.body = structuredClone(body);
      const res = new http.ServerResponse(req);
      res.end = data => { socket.destroy(); try { resolve({ status: res.statusCode, data: JSON.parse(String(data)) }); } catch (error) { reject(error); } return res; };
      app.handle(req, res, error => reject(error || Error('Route not handled')));
    });
  }
  let serial = 0;
  async function makeCase(overrides = {}) {
    return prisma.case.create({ data: {
      id: `A-DELIVERY-ACCEPTANCE-${++serial}`, title: 'Synthetic delivery acceptance', requester: 'Fixture', level: 'A',
      status: 'doing', designerId: people.owner.id, createdById: people.admin.id,
      collaborators: { connect: [{ id: people.collab.id }] },
      openDate: day('2026-10-01'), dispatchDate: day('2026-10-02'), goLiveDate: day('2026-10-31'),
      archivePath: '/fixture/archive', items: [], requestCount: null, outputCount: null, ...overrides,
    } });
  }

  const current = id => prisma.case.findUnique({ where: { id } });
  const version = row => ({ expectedUpdatedAt: new Date(row.updatedAt).toISOString(), expectedContentVersion: row.contentVersion });
  let requestSerial = 0;
  const payload = (row, overrides = {}) => ({
    id: `independent_delivery_${++requestSerial}`, itemName: 'Main visual', kind: 'main', quantity: 1,
    unit: '件', deliveredOn: '2026-10-23', ...version(row), ...overrides,
  });
  const add = (row, overrides = {}, actor = 'owner') => call(row.id + '/deliveries', 'POST', payload(row, overrides), actor);
  const groups = data => data.summary.groups.map(({ kind, unit, quantity }) => ({ kind, unit, quantity }));

  await test('default-off delivery endpoint has no mutation side effects', async () => {
    const row = await makeCase();
    assert.equal((await call(row.id + '/deliveries')).status, 404);
    assert.equal((await add(row)).status, 404);
    assert.equal(await prisma.deliveryRecord.count(), 0);
    assert.equal((await current(row.id)).contentVersion, row.contentVersion);
  });
  process.env.DELIVERY_RECORDS_ENABLED = '1';
  await test('main1 and extension3 are separate; legacy unknowns and collaborator attribution remain intact', async () => {
    const row = await makeCase();
    const first = await add(row); assert.equal(first.status, 201);
    const second = await add(await current(row.id), { kind: 'extension', quantity: 3, itemName: 'Three sizes' }, 'collab');
    assert.equal(second.status, 201); assert.equal(second.data.record.recordedById, people.collab.id);
    const fresh = await call(row.id + '/deliveries'); assert.equal(fresh.status, 200);
    assert.deepEqual(groups(fresh.data), [{ kind: 'main', unit: '件', quantity: 1 }, { kind: 'extension', unit: '件', quantity: 3 }]);
    assert.equal(fresh.data.records.length, 2); assert.equal(fresh.data.legacy.outputCountStatus, 'unknown');
    const stored = await current(row.id); assert.equal(stored.requestCount, null); assert.equal(stored.outputCount, null);
    assert.equal(fresh.data.contentVersion, stored.contentVersion);
  });
  await test('zero support is known zero with explanation; invalid quantities and calendar dates never write', async () => {
    const row = await makeCase();
    for (const values of [
      { quantity: -1 }, { quantity: 1.5 }, { quantity: 1000001 }, { quantity: '1' },
      { quantity: 0 }, { kind: 'support', quantity: 0, note: '   ' },
      { deliveredOn: '2026-02-29' }, { deliveredOn: '2026-04-31' }, { deliveredOn: '2030-01-01' },
      { unit: '份' }, { recordedById: people.admin.id },
    ]) assert([400,422].includes((await add(row, values)).status), JSON.stringify(values));
    assert.equal(await prisma.deliveryRecord.count({ where: { caseId: row.id } }), 0);
    assert.equal((await current(row.id)).contentVersion, row.contentVersion);
    const result = await add(row, { kind: 'support', quantity: 0, note: '提供配色與版面諮詢，沒有新增設計檔案' });
    assert.equal(result.status, 201);
    const summary = (await call(row.id + '/deliveries')).data.summary;
    assert.equal(summary.status, 'recorded'); assert.equal(summary.zeroSupportRecords, 1); assert.equal(summary.groups[0].quantity, 0);
  });
  await test('unrelated and observer cannot write; recorded actor cannot be impersonated', async () => {
    const row = await makeCase();
    for (const actor of ['other','observer']) assert.equal((await add(row, {}, actor)).status, 403);
    assert.equal((await add(row, { recordedByName: 'Forged' })).status, 400);
    assert.equal(await prisma.deliveryRecord.count({ where: { caseId: row.id } }), 0);
    assert.equal((await add(row, {}, 'admin')).status, 201);
  });
  await test('lost-response retry replays without a second row or version advance; changed content conflicts', async () => {
    const row = await makeCase(), body = payload(row);
    const first = await call(row.id + '/deliveries', 'POST', body); assert.equal(first.status, 201);
    const after = await current(row.id);
    const replay = await call(row.id + '/deliveries', 'POST', body); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
    assert.equal((await current(row.id)).contentVersion, after.contentVersion);
    assert.equal((await call(row.id + '/deliveries', 'POST', { ...body, quantity: 2 })).status, 409);
    assert.equal((await call(row.id + '/deliveries', 'POST', body, 'collab')).status, 409);
    assert.equal(await prisma.deliveryRecord.count({ where: { caseId: row.id } }), 1);
  });
  await test('real concurrent writes use case revision; same-ID concurrency has one durable delivery', async () => {
    const row = await makeCase();
    const outcomes = await Promise.all([add(row), add(row, { kind: 'extension', quantity: 3 })]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [201,409]);
    assert.equal(await prisma.deliveryRecord.count({ where: { caseId: row.id } }), 1);
    assert.equal((await current(row.id)).contentVersion, row.contentVersion + 1);
    const next = await makeCase(), body = payload(next);
    const same = await Promise.all([call(next.id + '/deliveries', 'POST', body), call(next.id + '/deliveries', 'POST', body)]);
    assert.deepEqual(same.map(r => r.status).sort(), [200,201]);
    assert.equal(await prisma.deliveryRecord.count({ where: { caseId: next.id } }), 1);
  });
  await test('void preserves immutable evidence, removes active quantity and safely replays', async () => {
    const row = await makeCase(), first = await add(row, { quantity: 3 }); assert.equal(first.status, 201);
    const beforeVoid = await current(row.id);
    const body = { requestId: `independent_void_${++requestSerial}`, reason: '更正誤填數量', ...version(beforeVoid) };
    const endpoint = row.id + '/deliveries/' + first.data.record.id + '/void';
    assert.equal((await call(endpoint, 'POST', { ...body, reason: '' })).status, 400);
    assert.equal((await call(endpoint, 'POST', body, 'other')).status, 403);
    assert.equal((await call(endpoint, 'POST', body)).status, 200);
    const replay = await call(endpoint, 'POST', body); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
    const fresh = (await call(row.id + '/deliveries')).data;
    assert.equal(fresh.summary.activeRecords, 0); assert.equal(fresh.summary.voidedRecords, 1);
    assert.equal(fresh.records[0].quantity, 3); assert.equal(fresh.records[0].voidReason, body.reason);
    assert.equal((await current(row.id)).contentVersion, beforeVoid.contentVersion + 1);
    assert.equal((await call(endpoint, 'POST', { ...body, reason: '另一個原因' })).status, 409);
  });
  await test('legacy keyless item save preserves a linked identity; removal and foreign keys are rejected', async () => {
    const row = await makeCase({ items: [{ n: 'Poster', type: '', owner: '', status: '尚未製作' }] });
    const keyed = await call(row.id + '/items', 'PATCH', { items: row.items, ...version(row) }); assert.equal(keyed.status, 200);
    const item = keyed.data.items[0]; assert(item.key);
    const linked = await add(await current(row.id), { itemKey: item.key, itemName: 'Poster delivery' }); assert.equal(linked.status, 201);
    let latest = await current(row.id);
    const { key, ...withoutKey } = latest.items[0];
    const oldSave = await call(row.id + '/items', 'PATCH', { items: [withoutKey], ...version(latest) });
    assert.equal(oldSave.status, 200); assert.equal(oldSave.data.items[0].key, key);
    latest = await current(row.id);
    assert.equal((await call(row.id + '/items', 'PATCH', { items: [], ...version(latest) })).status, 409);
    assert.equal((await call(row.id + '/items', 'PATCH', { items: [latest.items[0], latest.items[0]], ...version(latest) })).status, 422);
    const other = await makeCase({ items: [{ n: 'Other' }] });
    const otherItems = await call(other.id + '/items', 'PATCH', { items: other.items, ...version(other) });
    assert.equal((await add(latest, { itemKey: otherItems.data.items[0].key })).status, 422);
    assert.equal((await current(row.id)).items[0].key, key);
  });
  await test('sent, cancelled, archived and delivered cases reject new delivery mutations', async () => {
    for (const status of ['review_done','cancelled','done','closed']) {
      const row = await makeCase({ status }); assert.equal((await add(row)).status, 409);
      assert.equal((await current(row.id)).contentVersion, row.contentVersion);
    }
    const row = await makeCase({ archived: true }); assert.equal((await add(row)).status, 409);
  });
  await test('database retains original evidence and rejects deleting an evidenced case', async () => {
    const row = await makeCase(), first = await add(row); assert.equal(first.status, 201);
    const id = first.data.record.id;
    await assert.rejects(() => prisma.deliveryRecord.update({ where: { id }, data: { quantity: 99 } }));
    await assert.rejects(() => prisma.deliveryRecord.delete({ where: { id } }));
    await assert.rejects(() => prisma.case.delete({ where: { id: row.id } }));
    assert.equal((await call(row.id, 'DELETE', {}, 'admin')).status, 409);
    const fresh = await prisma.deliveryRecord.findUnique({ where: { id } }); assert.equal(fresh.quantity, 1);
    assert(await current(row.id));
  });
  await test('minimal keyed item from case creation survives an unchanged legacy form save', async () => {
    const created = await call('', 'POST', {
      title: 'Minimal create acceptance', requester: 'Fixture', level: 'A', designerId: people.owner.id,
      openDate: '2026-10-01', dispatchDate: '2026-10-02', goLiveDate: '2026-10-31', items: [{ n: 'Minimal item' }],
    }, 'admin');
    assert.equal(created.status, 201);
    const row = await current(created.data.id), key = row.items[0].key; assert(key);
    assert.equal((await add(row, { itemKey: key })).status, 201);
    const latest = await current(row.id);
    const saved = await call(row.id + '/items', 'PATCH', { items: [{ n: 'Minimal item' }], ...version(latest) });
    assert.equal(saved.status, 200, 'omitted optional defaults are unchanged content, not removal of a linked item');
    assert.equal(saved.data.items[0].key, key);
  });
  await test('omitting a previously explicit custom itemName is changed request content, not a replay', async () => {
    const row = await makeCase({ items: [{ n: 'Underlying task', type: '', owner: '', status: '尚未製作' }] });
    const keyed = await call(row.id + '/items', 'PATCH', { items: row.items, ...version(row) }); assert.equal(keyed.status, 200);
    const latest = await current(row.id);
    const body = payload(latest, { itemKey: keyed.data.items[0].key, itemName: 'Custom delivery name' });
    assert.equal((await call(row.id + '/deliveries', 'POST', body)).status, 201);
    const changed = { ...body }; delete changed.itemName;
    const replay = await call(row.id + '/deliveries', 'POST', changed);
    assert.equal(replay.status, 409, 'omitted name would resolve to Underlying task; it is not the original custom request');
    assert.equal(await prisma.deliveryRecord.count({ where: { caseId: row.id } }), 1);
  });
  console.log(`Independent real-PG delivery acceptance: ${passed} passed`);
} finally {
  if (prisma) await prisma.$disconnect();
  if (made) docker('exec', container, 'dropdb', '-U', username, '--force', dbName);
  const checkpoint = process.env.DELIVERY_ACCEPTANCE_STATE_PATH;
  if (checkpoint) fs.writeFileSync(checkpoint, JSON.stringify({ passed, results, isolatedDatabaseRemoved: made, database: dbName }, null, 2) + '\n');
}
