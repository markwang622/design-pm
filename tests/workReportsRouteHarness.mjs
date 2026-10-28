// REPORTS-P3-E1b: real express router + real requireAuth + actual PostgreSQL for the work-report API. Spawned only by
// tests/postgresMaintenance.mjs against a database it created on the labelled loopback fixture; refuses anything else.
// Evidence scope:
// - /api/work-reports        the production router object (default service, real sources: the ended periods of a fresh
//                            database are before coverage, so these are honest insufficient snapshots);
// - /api/hooked-reports      the same real source reader with a test-only pause/failure hook (races, revocation, rollback);
// - /api/stub-reports        a test-only SOURCE STUB (synthetic C/K projections) over the real publication, constraints,
//                            auth and reads — it proves publication/filter/immutability of non-empty payloads, not
//                            source history end to end (that is E1a's accepted PG evidence).
// The hook and the stub are wired only here (service factory injection); no HTTP body, env or production switch reaches them.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = process.env.DESIGN_PM_ROOT;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser');
const target = new URL(process.env.DATABASE_URL);
assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, process.env.EXPECTED_FIXTURE_PORT); assert.equal(target.pathname, '/' + process.env.EXPECTED_OWNED_DB);
assert.match(process.env.EXPECTED_OWNED_DB, new RegExp('^' + process.env.EXPECTED_DB_PREFIX + '_[a-z0-9_]+_reportapi$'));
assert.equal(process.env.NODE_ENV, 'test');
for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_')) delete process.env[key];

const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const WR = await import(root + '/src/lib/workReports.js');
const P = await import(root + '/src/lib/workReportPayload.js');
const RP = await import(root + '/src/lib/reportPeriods.js');
const routes = await import(root + '/src/routes/workReports.js');

let hook = null;
const hooked = WR.createWorkReportService({ readSources: (db, o, fn) => WR.readReportSources(db, o, async (tx, src) => {
  if (hook) await hook('read'); const r = await fn(tx, src); if (hook) await hook('after'); return r; }) });
let stub = null;
const stubbed = WR.createWorkReportService({ readSources: (db, o, fn) => db.$transaction(async tx => {
  const [c] = await tx.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`);
  return fn(tx, { ...stub(o), observedAt: c.now, knowledgeCutoff: o.knowledgeCutoff });
}, { isolationLevel: 'RepeatableRead', timeout: 30000 }) });

const app = express(); app.use(express.json(), cookieParser());
app.use('/api/work-reports', routes.default);
app.use('/api/hooked-reports', routes.createWorkReportsRouter(hooked));
app.use('/api/stub-reports', routes.createWorkReportsRouter(stubbed));
const unhandled = []; app.use((error, _req, res, _next) => { unhandled.push(String(error.message)); res.status(500).json({ error: 'server_error' }); });
const server = app.listen(0, '127.0.0.1'); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const base = 'http://127.0.0.1:' + server.address().port;
async function call(mount, path, method, body, actor, sv = 0) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor != null) headers.Cookie = 'designpm_token=' + signToken({ id: actor, sessionVersion: sv });
  const r = await fetch(base + '/api/' + mount + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return { status: r.status, data: await r.json() };
}
const api = (path, method, body, actor, sv) => call('work-reports', path, method, body, actor, sv);
function twoWay() { let n = 0, release, timer; const gate = new Promise((res, rej) => { release = res; timer = setTimeout(() => rej(Error('both requests must reach the barrier')), 8000); });
  return { arrive: async () => { if (++n === 2) { clearTimeout(timer); release(); } if (n <= 2) await gate; }, done: () => clearTimeout(timer) }; }
const day = s => new Date(s + 'T00:00:00Z');
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
let staffSeq = 0;
const mk = (name, role, extra = {}) => prisma.staff.create({ data: { name, email: 'wr-staff-' + (++staffSeq) + '@example.invalid', password: 'unusable-fixture-value',
  role, seniority: 'mid', joined: day('2026-01-05'), ...extra } });
const count = async (period) => Number((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM report_snapshots WHERE "periodKind"=$1 AND "startDate"=$2::date`, period.kind, period.startDate))[0].n);
const rowDigest = async id => (await prisma.$queryRawUnsafe(`SELECT md5(row_to_json(t)::text) AS d FROM report_snapshots t WHERE id=$1`, id))[0]?.d;
let scenarios = 0;
const done = () => { scenarios++; };

try {
  const admin1 = await mk('WR admin one', 'admin'), admin2 = await mk('WR admin two', 'admin'), member = await mk('WR member', 'member'), observer = await mk('WR observer', 'observer');
  const inactive = await mk('WR inactive admin', 'admin', { active: false }), pending = await mk('WR pending admin', 'admin', { pendingActivation: true });
  const admin3 = await mk('WR admin three', 'admin'), admin4 = await mk('WR admin four', 'admin'), admin5 = await mk('WR admin five', 'admin');
  const [{ today }] = await prisma.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS today`);
  const cur = RP.periodContaining('week', today), future = RP.nextPeriod(cur);
  const w = [cur]; for (let i = 1; i <= 7; i++) w.push(RP.previousPeriod(w[i - 1]));

  // A. real session / role / body: 401, 403, forged fields rejected
  const q = '/periods?kind=week&from=' + w[2].startDate + '&to=' + w[1].startDate;
  assert.equal((await api(q, 'GET', null, null)).status, 401);
  assert.deepEqual([(await api(q, 'GET', null, member.id)).status, (await api(q, 'GET', null, member.id)).data.error], [403, 'admin_only']);
  assert.equal((await api(q, 'GET', null, observer.id)).status, 403);
  assert.equal((await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'obs-gen-0001' }, observer.id)).status, 403);
  for (const [actor, sv] of [[inactive.id, 0], [pending.id, 0], [admin1.id, 3]]) {
    const r = await api(q, 'GET', null, actor, sv); assert.deepEqual([r.status, r.data.error], [401, 'session_expired']);
  }
  assert.equal((await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'forged-0001', role: 'admin' }, member.id)).status, 403);
  const forged = await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'forged-0002', actorId: admin2.id }, admin1.id);
  assert.deepEqual([forged.status, forged.data.error], [400, 'invalid_body']); done();

  // B. bounded / normalised inputs
  const tooMany = await api('/periods?kind=week&from=2020-01-06&to=' + today, 'GET', null, admin1.id); assert.deepEqual([tooMany.status, tooMany.data.code], [400, 'range_too_large']);
  assert.deepEqual((await api('/periods?kind=week&from=2026-13-01&to=2026-10-01', 'GET', null, admin1.id)).data.code, 'invalid_date');
  assert.equal((await api('/periods?kind=week&from=' + today + '&to=' + today + '&extra=1', 'GET', null, admin1.id)).data.error, 'invalid_query');
  assert.equal((await api('/periods?kind=year&from=' + today + '&to=' + today, 'GET', null, admin1.id)).status, 400);
  const unaligned = await api('/generate', 'POST', { periodKind: 'week', startDate: addDays(w[1].startDate, 1), idempotencyKey: 'unaligned-0001' }, admin1.id);
  assert.deepEqual([unaligned.status, unaligned.data.code], [400, 'unaligned_period_start']);
  for (const p of [future, cur]) {
    const r = await api('/generate', 'POST', { periodKind: 'week', startDate: p.startDate, idempotencyKey: 'future-' + p.startDate }, admin1.id);
    assert.deepEqual([r.status, r.data.error], [422, 'period_not_ended']);
  }
  assert.equal((await api('/wr_not-an-id', 'GET', null, admin1.id)).status, 404);
  assert.equal((await api('/wr_' + crypto.randomUUID(), 'GET', null, admin1.id)).status, 404);
  assert.equal((await api('/wr_' + crypto.randomUUID() + '?staffId=0', 'GET', null, admin1.id)).status, 400);
  assert.equal((await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'bad key!' }, admin1.id)).status, 400);
  assert.equal(await count(w[1]), 0); done();

  // C. initial version through the production router: honest insufficient snapshot, replay and key binding
  const g1 = await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'gen-w1-0001' }, admin1.id);
  assert.equal(g1.status, 201, JSON.stringify(g1.data)); const v1 = g1.data.snapshot;
  assert.deepEqual([v1.revision, v1.sourceCompleteness, v1.knowledgeCutoff, v1.supersedesId, v1.generatedById], [1, 'insufficient', v1.cutoffInstant, null, admin1.id]);
  assert.equal(v1.cutoffInstant, RP.periodInstants(w[1]).cutoffInstant); assert(v1.generatedAt >= v1.observedAt && v1.observedAt >= v1.knowledgeCutoff);
  assert.equal('idempotencyKey' in v1, false);
  const got = await api('/' + v1.id, 'GET', null, admin1.id);
  assert.equal(got.status, 200); assert.deepEqual(got.data.payload.rows, []); assert.deepEqual(got.data.payload.summary.caseCount, { knownSubtotal: null, total: null });
  assert.equal(P.payloadSha256(got.data.payload), v1.payloadSha256); assert.equal(got.data.payloadSha256, v1.payloadSha256);
  assert.deepEqual(got.data.payload.sourceCompleteness.reasons, ['end_state_before_coverage']);
  const view = await api('/' + v1.id + '?staffId=' + admin1.id, 'GET', null, admin1.id);
  assert.equal(view.data.payloadSha256, v1.payloadSha256); assert.equal(view.data.view.derivedFrom.payloadSha256, v1.payloadSha256);
  assert.notEqual(view.data.view.viewSha256, v1.payloadSha256); assert.equal(P.payloadSha256(view.data.view.payload), view.data.view.viewSha256);
  const replay = await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'gen-w1-0001' }, admin1.id);
  assert.deepEqual([replay.status, replay.data.replayed, replay.data.snapshot], [200, true, v1]);
  const otherBody = await api('/generate', 'POST', { periodKind: 'week', startDate: w[2].startDate, idempotencyKey: 'gen-w1-0001' }, admin1.id);
  assert.deepEqual([otherBody.status, otherBody.data.error], [409, 'idempotency_conflict']);
  const otherActor = await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'gen-w1-0001' }, admin2.id);
  assert.deepEqual([otherActor.status, otherActor.data.error], [409, 'idempotency_conflict']);
  const otherRoute = await api('/' + v1.id + '/revisions', 'POST', { reason: '期後補登交付', expectedLatestRevision: 1, idempotencyKey: 'gen-w1-0001' }, admin1.id);
  assert.deepEqual([otherRoute.status, otherRoute.data.error], [409, 'idempotency_conflict']);
  const exists = await api('/generate', 'POST', { periodKind: 'week', startDate: w[1].startDate, idempotencyKey: 'gen-w1-0002' }, admin2.id);
  assert.deepEqual([exists.status, exists.data.error, exists.data.details.snapshotId], [409, 'report_exists', v1.id]);
  const versions = await api('/?kind=week&start=' + w[1].startDate, 'GET', null, admin1.id);
  assert.deepEqual(versions.data.versions.map(v => v.id), [v1.id]);
  const periods = await api('/periods?kind=week&from=' + w[2].startDate + '&to=' + future.startDate, 'GET', null, admin1.id);
  assert.deepEqual(periods.data.periods.map(p => [p.startDate, p.ended, p.versions.length]), [[w[2].startDate, true, 0], [w[1].startDate, true, 1], [cur.startDate, false, 0], [future.startDate, false, 0]]);
  assert.equal(await count(w[1]), 1); done();

  // D. revisions: adjacency, expectedLatest, reason, legal same-key resend after newer versions, old version untouched
  const v1Digest = await rowDigest(v1.id);
  const r1Body = { reason: '期後補登交付', expectedLatestRevision: 1, idempotencyKey: 'rev-w1-0001' };
  const r1 = await api('/' + v1.id + '/revisions', 'POST', r1Body, admin1.id); assert.equal(r1.status, 201, JSON.stringify(r1.data)); const v2 = r1.data.snapshot;
  assert.deepEqual([v2.revision, v2.supersedesId, v2.revisionReason, v2.cutoffInstant], [2, v1.id, '期後補登交付', v1.cutoffInstant]); assert(v2.knowledgeCutoff > v2.cutoffInstant);
  const notLatest = await api('/' + v1.id + '/revisions', 'POST', { ...r1Body, idempotencyKey: 'rev-w1-0002' }, admin1.id);
  assert.deepEqual([notLatest.status, notLatest.data.error, notLatest.data.details.latestId], [409, 'not_latest_revision', v2.id]);
  const stale = await api('/' + v2.id + '/revisions', 'POST', { ...r1Body, idempotencyKey: 'rev-w1-0003' }, admin1.id);
  assert.deepEqual([stale.status, stale.data.error], [409, 'revision_conflict']);
  assert.equal((await api('/' + v2.id + '/revisions', 'POST', { reason: '更新', expectedLatestRevision: 2, idempotencyKey: 'rev-w1-0004' }, admin1.id)).status, 400);
  assert.equal((await api('/' + v2.id + '/revisions', 'POST', { reason: '補登', expectedLatestRevision: 2 }, admin1.id)).status, 400);
  const r2 = await api('/' + v2.id + '/revisions', 'POST', { reason: '第二次更正交付', expectedLatestRevision: 2, idempotencyKey: 'rev-w1-0005' }, admin2.id);
  assert.equal(r2.status, 201); assert.equal(r2.data.snapshot.revision, 3); assert(r2.data.snapshot.knowledgeCutoff >= v2.knowledgeCutoff);
  const resend = await api('/' + v1.id + '/revisions', 'POST', r1Body, admin1.id);
  assert.deepEqual([resend.status, resend.data.replayed, resend.data.snapshot.id], [200, true, v2.id], 'a legal resend still replays after newer versions');
  assert.equal((await api('/' + v1.id + '/revisions', 'POST', r1Body, admin2.id)).data.error, 'idempotency_conflict');
  assert.equal(await rowDigest(v1.id), v1Digest, 'old version row byte-identical'); assert.equal((await api('/' + v1.id, 'GET', null, admin1.id)).data.payloadSha256, v1.payloadSha256);
  assert.equal(await count(w[1]), 3); done();

  // E. GET never writes
  const state = async () => (await prisma.$queryRawUnsafe(`SELECT (SELECT count(*) FROM report_snapshots)::int AS s, (SELECT coalesce(max(id),0) FROM report_source_events)::text AS e,
    (SELECT md5(string_agg(md5(row_to_json(t)::text), '' ORDER BY id)) FROM report_snapshots t) AS d`))[0];
  const before = await state();
  for (const path of [q, '/?kind=week&start=' + w[1].startDate, '/' + v1.id, '/' + v2.id + '?hotel=none', '/' + v2.id + '?staffId=' + admin2.id]) assert.equal((await api(path, 'GET', null, admin1.id)).status, 200);
  assert.deepEqual(await state(), before); done();

  // F. overlapping publication of the same new period (real sources, both inside their snapshot at once)
  let barrier = twoWay(); hook = async phase => { if (phase === 'read') await barrier.arrive(); };
  const pair = await Promise.all(['gen-w2-000A', 'gen-w2-000B'].map((k, i) => call('hooked-reports', '/generate', 'POST', { periodKind: 'week', startDate: w[2].startDate, idempotencyKey: k }, [admin1.id, admin2.id][i])));
  barrier.done(); hook = null;
  assert.deepEqual(pair.map(r => r.status).sort(), [201, 409]); assert.equal(pair.find(r => r.status === 409).data.error, 'report_exists'); assert.equal(await count(w[2]), 1);
  barrier = twoWay(); hook = async phase => { if (phase === 'read') await barrier.arrive(); };
  const same = await Promise.all([0, 1].map(() => call('hooked-reports', '/generate', 'POST', { periodKind: 'week', startDate: w[3].startDate, idempotencyKey: 'gen-w3-0001' }, admin1.id)));
  barrier.done(); hook = null;
  assert.deepEqual(same.map(r => r.status).sort(), [200, 201]); assert.equal(same[0].data.snapshot.id, same[1].data.snapshot.id); assert.equal(await count(w[3]), 1); done();

  // G. overlapping revisions of the same latest version: exactly one new version
  const w2v1 = pair.find(r => r.status === 201).data.snapshot, w3v1 = same.find(r => r.status === 201).data.snapshot;
  const revPair = await Promise.all(['rev-w2-000A', 'rev-w2-000B'].map((k, i) => api('/' + w2v1.id + '/revisions', 'POST', { reason: '並行修訂測試', expectedLatestRevision: 1, idempotencyKey: k }, [admin1.id, admin2.id][i])));
  assert.deepEqual(revPair.map(r => r.status).sort(), [201, 409], JSON.stringify(revPair.map(r => r.data)));
  assert(['not_latest_revision', 'revision_conflict', 'report_conflict', 'source_not_settled'].includes(revPair.find(r => r.status === 409).data.error));
  assert.equal(await count(w[2]), 2);
  const revSame = await Promise.all([0, 1].map(() => api('/' + w3v1.id + '/revisions', 'POST', { reason: '同鍵重送測試', expectedLatestRevision: 1, idempotencyKey: 'rev-w3-0001' }, admin1.id)));
  assert.deepEqual(revSame.map(r => r.status).sort(), [200, 201], JSON.stringify(revSame.map(r => r.data))); assert.equal(revSame[0].data.snapshot.id, revSame[1].data.snapshot.id);
  assert.equal(await count(w[3]), 2); done();

  // H. revocation racing a publication that already holds its source snapshot: demotion, session revocation, deactivation
  for (const [actor, change, status, code] of [[admin3, { role: 'member' }, 403, 'admin_only'], [admin4, { sessionVersion: { increment: 1 } }, 401, 'session_expired'],
    [admin5, { active: false }, 403, 'actor_inactive']]) {
    let fired = false;
    hook = async phase => { if (phase === 'read' && !fired) { fired = true; await prisma.staff.update({ where: { id: actor.id }, data: change }); } };
    const r = await call('hooked-reports', '/generate', 'POST', { periodKind: 'week', startDate: w[4].startDate, idempotencyKey: 'race-' + actor.id + '-0001' }, actor.id);
    hook = null; assert(fired); assert.deepEqual([r.status, r.data.error], [status, code], JSON.stringify(r.data)); assert.equal(await count(w[4]), 0);
  }
  done();

  // I. atomic failure: after the INSERT (rolled back with its transaction) and before it (sources not settled)
  let thrown = false; hook = async phase => { if (phase === 'after' && !thrown) { thrown = true; throw Error('synthetic failure after the snapshot insert'); } };
  const failed = await call('hooked-reports', '/generate', 'POST', { periodKind: 'week', startDate: w[5].startDate, idempotencyKey: 'fail-w5-0001' }, admin1.id);
  hook = null; assert.equal(failed.status, 500); assert.equal(await count(w[5]), 0);
  assert.equal((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM report_snapshots WHERE "idempotencyKey"='fail-w5-0001'`))[0].n, 0);
  let release; const gate = new Promise(r => { release = r; }); let opened; const ready = new Promise(r => { opened = r; });
  const holding = prisma.$transaction(async tx => { await tx.$queryRawUnsafe('SELECT 1'); opened(); await gate; }, { timeout: 60000 });
  await ready;
  const blocked = await api('/' + r2.data.snapshot.id + '/revisions', 'POST', { reason: '來源未結束時修訂', expectedLatestRevision: 3, idempotencyKey: 'blocked-w1-0001' }, admin1.id);
  release(); await holding;
  assert.deepEqual([blocked.status, blocked.data.error, blocked.data.details?.reason], [409, 'source_not_settled', 'open_transactions']); assert.equal(await count(w[1]), 3);
  const retried = await api('/' + r2.data.snapshot.id + '/revisions', 'POST', { reason: '來源未結束時修訂', expectedLatestRevision: 3, idempotencyKey: 'blocked-w1-0001' }, admin1.id);
  assert.equal(retried.status, 201, 'the same key succeeds once the sources settle'); done();

  // J. SOURCE STUB over real publication: non-empty payload, filters from the stored payload, live renames / deletion,
  //    revision with void + backfill, v1 unchanged
  const liveHotel = await prisma.hotel.create({ data: { region: 'Stub', name: 'Stub館', sortOrder: 5 } });
  const designer = await mk('Stub設計', 'member'), helper = await mk('Stub協作', 'member');
  await prisma.case.create({ data: { id: 'STUB-2026-001', title: 'Stub 案件', requester: 'Fixture', level: 'A', status: 'doing', designerId: designer.id, hotel: 'Stub館',
    openDate: day(w[6].startDate), dispatchDate: day(w[6].startDate), goLiveDate: day(addDays(w[6].startDate, 30)), collaborators: { connect: [{ id: helper.id }] } } });
  const p6 = w[6], d1 = addDays(p6.startDate, 1), early = '2000-01-01T00:00:00.000000Z';
  const tablesOf = (title, deliveries) => {
    const t = { cases: {}, _collaborators: {}, case_deliveries: {}, case_cycles: {}, case_lifecycle_requests: {}, case_schedule_requests: {}, case_delivery_submissions: {}, staff: {}, hotels: {}, change_logs: {} };
    t.staff[designer.id] = { id: designer.id, name: 'Stub設計', role: 'member', active: true, departedOn: null }; t.staff[helper.id] = { id: helper.id, name: 'Stub協作', role: 'member', active: true, departedOn: null };
    t.hotels[liveHotel.id] = { id: liveHotel.id, region: 'Stub', name: 'Stub館', sortOrder: 5, active: true };
    t.cases['STUB-2026-001'] = { id: 'STUB-2026-001', title, hotel: 'Stub館', level: 'A', status: 'doing', archived: false, designerId: designer.id, deliveryMode: 'records', lifecycleMode: 'legacy',
      scheduleMode: 'legacy', openDate: p6.startDate, dispatchDate: p6.startDate, goLiveDate: addDays(p6.startDate, 30), logs: [{ id: 'stub-log-0001', date: d1, note: '初稿完成' }] };
    t._collaborators['STUB-2026-001:' + helper.id] = { caseId: 'STUB-2026-001', staffId: helper.id };
    for (const d of deliveries) t.case_deliveries[d.id] = { caseId: 'STUB-2026-001', itemKey: null, itemName: '主視覺', unit: '件', deliveredOn: d1, note: null, recordedById: designer.id,
      recordedByName: 'Stub設計', cycleId: null, voidedAt: null, voidReason: null, ...d };
    return t;
  };
  const cState = { status: 'ok', coverageStart: early, maxEventId: '41', tables: tablesOf('Stub 案件', [{ id: 'stub-d1', kind: 'main', quantity: 2 }]) };
  const kState = { status: 'ok', coverageStart: early, maxEventId: '57', tables: tablesOf('Stub 案件（K 改名）', [{ id: 'stub-d1', kind: 'main', quantity: 2, voidedAt: addDays(p6.endDateExclusive, 1) + 'T01:00:00', voidReason: '數量更正' },
    { id: 'stub-d2', kind: 'main', quantity: 3 }]) };
  stub = o => ({ endState: cState, knowledge: o.knowledgeCutoff === o.cutoff ? cState : kState, deletedCaseIds: [], coverageStart: early });
  const sg = await call('stub-reports', '/generate', 'POST', { periodKind: 'week', startDate: p6.startDate, idempotencyKey: 'stub-w6-0001' }, admin1.id);
  assert.equal(sg.status, 201, JSON.stringify(sg.data)); const s1 = sg.data.snapshot; assert.deepEqual([s1.sourceCompleteness, s1.endStateMaxEventId, s1.knowledgeMaxEventId], ['complete', '41', '41']);
  const s1Get = await call('stub-reports', '/' + s1.id, 'GET', null, admin1.id);
  assert.deepEqual(s1Get.data.payload.summary.deliveries.period.map(g => [g.kind, g.knownSubtotal, g.total]), [['main', 2, 2]]);
  const [stored] = await prisma.$queryRawUnsafe(`SELECT payload FROM report_snapshots WHERE id=$1`, s1.id);
  for (const [qs, filter, n] of [['?staffId=' + helper.id, { staffId: helper.id }, 1], ['?staffId=' + admin1.id, { staffId: admin1.id }, 0], ['?hotel=hotel:' + liveHotel.id, { hotel: 'hotel:' + liveHotel.id }, 1]]) {
    const v = await call('stub-reports', '/' + s1.id + qs, 'GET', null, admin1.id);
    assert.deepEqual(v.data.view.payload, P.filterPayload(stored.payload, filter)); assert.equal(v.data.view.payload.rows.length, n);
  }
  const s1Before = await call('work-reports', '/' + s1.id + '?staffId=' + helper.id, 'GET', null, admin1.id);
  await prisma.hotel.update({ where: { id: liveHotel.id }, data: { name: 'Stub館（改名）', sortOrder: 999 } });
  await prisma.staff.update({ where: { id: helper.id }, data: { name: 'Stub協作（改名）' } });
  await prisma.case.delete({ where: { id: 'STUB-2026-001' } });
  const s1After = await call('work-reports', '/' + s1.id + '?staffId=' + helper.id, 'GET', null, admin1.id);
  assert.deepEqual(s1After.data, s1Before.data, 'live renames / deletion never change a stored report or its filtered view');
  assert.equal(s1After.data.view.payload.rows[0].hotel.raw, 'Stub館'); assert.equal(s1After.data.view.payload.staff.find(s => s.id === helper.id).name, 'Stub協作');
  const sr = await call('stub-reports', '/' + s1.id + '/revisions', 'POST', { reason: '交付數量更正後重產', expectedLatestRevision: 1, idempotencyKey: 'stub-w6-rev1' }, admin1.id);
  assert.equal(sr.status, 201, JSON.stringify(sr.data)); assert.equal(sr.data.snapshot.knowledgeMaxEventId, '57');
  const s2 = (await call('work-reports', '/' + sr.data.snapshot.id, 'GET', null, admin1.id)).data.payload;
  const row = s2.rows[0];
  assert.deepEqual([row.title, row.deliveries.period.records.map(d => [d.id, d.knowledge]), row.deliveries.voidedAfterCutoff.map(d => d.id)], ['Stub 案件', [['stub-d2', 'recorded_after_cutoff']], ['stub-d1']]);
  assert.deepEqual(s2.summary.deliveries.period.map(g => [g.kind, g.total]), [['main', 3]]);
  assert.deepEqual((await call('work-reports', '/' + s1.id, 'GET', null, admin1.id)).data.payload, s1Get.data.payload, 'v1 unchanged after the revision');
  done();

  assert.deepEqual(unhandled, ['synthetic failure after the snapshot insert'], 'the only server error is the injected one');
  console.log(JSON.stringify({ workReportRouteScenarios: scenarios, productionRouterAndRequireAuth: true, actualPostgres: true, sourceStubScenarios: 1, unhandledServerErrors: unhandled.length }));
} finally {
  server.closeAllConnections(); await new Promise(r => server.close(r)); await prisma.$disconnect();
}
