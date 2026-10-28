// REPORTS-P3-E3: scheduled initial work reports — pure planning, configuration, failure classification, the internal
// scheduled entry's guards and the worker's fail-safe behaviour, on the real product modules (no DB, network, timers or mail).
// Durable jobs, leases, races, replay after a crash, epochs, retries and backup/restore run on real PostgreSQL in
// tests/postgresMaintenance.mjs (tests/workReportSchedulerHarness.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = process.env.DESIGN_PM_ROOT || decodeURIComponent(new URL('../', import.meta.url).pathname);
const SCH = await import(root + '/src/services/workReportScheduler.js');
const WR = await import(root + '/src/lib/workReports.js');
const RP = await import(root + '/src/lib/reportPeriods.js');
const { RULES_VERSION } = await import(root + '/src/lib/workReportPayload.js');
const { validateRuntimeConfig, validateWorkReportScheduler, ConfigurationError } = await import(root + '/src/lib/runtimeConfig.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const plan = (kind, startDate, now, cursor = null, limit) => SCH.planDue(kind, { cursor, startDate, now, limit });
const starts = list => list.map(p => p.startDate);

await test('due = Taipei 00:05 of endDateExclusive (C + 5 min) for natural weeks, months and quarters, across the year boundary', () => {
  const due = (k, s) => SCH.dueInstant(RP.periodFromStart(k, s));
  assert.equal(due('week', '2026-10-26'), '2026-11-01T16:05:00.000000Z', 'week → Monday 00:05 Taipei');
  assert.equal(due('month', '2026-10-01'), '2026-10-31T16:05:00.000000Z', 'month → the 1st 00:05 Taipei');
  assert.equal(due('quarter', '2026-10-01'), '2026-12-31T16:05:00.000000Z', 'Q4 → 1 Jan 00:05 Taipei');
  assert.equal(due('week', '2026-12-28'), '2027-01-03T16:05:00.000000Z', 'ISO week 2026-W53 spans the year');
  assert.equal(due('month', '2026-12-01'), '2026-12-31T16:05:00.000000Z');
  assert.equal(due('month', '2028-02-01'), '2028-02-29T16:05:00.000000Z', 'leap February');
  for (const k of RP.PERIOD_KINDS) { const p = RP.periodContaining(k, '2026-10-28'); assert.equal(SCH.dueInstant(p).slice(0, 10) <= p.endDateExclusive, true); }
  // the report itself still uses C (Taipei 00:00), never the run time
  assert.equal(RP.periodInstants(RP.periodFromStart('week', '2026-10-26')).cutoffInstant, '2026-11-01T16:00:00.000000Z');
});

await test('00:05 boundary: one microsecond before the due instant nothing is due; at it exactly the period is due', () => {
  assert.deepEqual(plan('week', '2026-10-28', '2026-11-01T16:04:59.999999Z'), []);
  assert.deepEqual(starts(plan('week', '2026-10-28', '2026-11-01T16:05:00.000000Z')), ['2026-10-26']);
  assert.deepEqual(plan('quarter', '2026-10-28', '2026-12-31T16:04:59.999999Z'), []);
  assert.deepEqual(starts(plan('quarter', '2026-10-28', '2026-12-31T16:05:00.000000Z')), ['2026-10-01']);
  // the Taipei new year: week W53, December and Q4 all due within the same five minutes
  const ny = '2027-01-03T16:05:00.000000Z';
  assert.deepEqual(starts(plan('week', '2026-12-20', ny)), ['2026-12-14', '2026-12-21', '2026-12-28'], 'start Sun 12-20: the week due Mon 12-21 is included');
  assert.deepEqual(starts(plan('month', '2026-12-20', ny)), ['2026-12-01']);
});

await test('activation lower bound: only periods due on/after the start date; production 2026-10-28 → first due month Oct, week W44, Q4', () => {
  const s = '2026-10-28';
  assert.deepEqual(['week', 'month', 'quarter'].map(k => SCH.firstScheduledPeriod(k, s).label), ['2026-W44', '2026-10', '2026-Q4']);
  assert.deepEqual(['week', 'month', 'quarter'].map(k => SCH.nextDue(k, { cursor: null, startDate: s }).dueAt),
    ['2026-11-01T16:05:00.000000Z', '2026-10-31T16:05:00.000000Z', '2026-12-31T16:05:00.000000Z']);
  // a start date that is itself a boundary includes the period ending on it (due that morning), never earlier ones
  assert.equal(SCH.firstScheduledPeriod('week', '2026-11-02').startDate, '2026-10-26');
  assert.equal(SCH.firstScheduledPeriod('month', '2026-11-01').startDate, '2026-10-01');
  assert.equal(SCH.firstScheduledPeriod('quarter', '2027-01-01').startDate, '2026-10-01');
  assert.deepEqual(plan('month', s, '2026-10-30T00:00:00.000000Z'), [], 'activation never scans earlier history');
  assert(SCH.startDateInWindow('2026-10-28', '2026-10-28') && !SCH.startDateInWindow('2020-01-01', '2026-10-28') && !SCH.startDateInWindow('2028-01-01', '2026-10-28'));
});

await test('bounded catch-up after downtime: oldest first, at most the limit per tick, continuing from the cursor without gaps or repeats', () => {
  const now = '2026-10-28T03:00:00.000000Z';
  const first = plan('week', '2026-05-04', now);
  assert.equal(first.length, SCH.ENQUEUE_LIMIT); assert.equal(first[0].startDate, '2026-04-27');
  const second = plan('week', '2026-05-04', now, first.at(-1).endDateExclusive);
  assert.equal(second[0].startDate, first.at(-1).endDateExclusive, 'cursor = endDateExclusive of the last enqueued period');
  const all = [...first, ...second, ...plan('week', '2026-05-04', now, second.at(-1).endDateExclusive)];
  for (let i = 1; i < all.length; i++) assert.equal(all[i].startDate, all[i - 1].endDateExclusive, 'consecutive');
  assert.equal(all.at(-1).startDate, '2026-10-19', 'up to the last ended week only'); assert.equal(new Set(starts(all)).size, all.length);
  assert.deepEqual(starts(plan('month', '2026-05-04', now)), ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']);
  assert.deepEqual(starts(plan('quarter', '2026-05-04', now)), ['2026-04-01', '2026-07-01']);
  assert.deepEqual(plan('month', '2026-05-04', now, '2026-10-01'), [], 'idle: nothing due after the cursor');
});

await test('feature flag is off by default and only "true" enables; enabling requires an explicit real start date; values never echoed', () => {
  assert.deepEqual({ ...validateWorkReportScheduler({}) }, { enabled: false, startDate: null });
  assert.equal(validateRuntimeConfig({ NODE_ENV: 'development' }).workReportScheduler.enabled, false);
  assert.deepEqual({ ...validateWorkReportScheduler({ WORK_REPORT_SCHEDULER_ENABLED: 'true', WORK_REPORT_SCHEDULER_START_DATE: '2026-10-28' }) }, { enabled: true, startDate: '2026-10-28' });
  assert.equal(validateWorkReportScheduler({ WORK_REPORT_SCHEDULER_ENABLED: 'false', WORK_REPORT_SCHEDULER_START_DATE: '2026-10-28' }).enabled, false);
  for (const v of ['TRUE', '1', 'yes', 'on', ' true', '', 'DoNotPrintValue']) assert.throws(() => validateWorkReportScheduler({ WORK_REPORT_SCHEDULER_ENABLED: v, WORK_REPORT_SCHEDULER_START_DATE: '2026-10-28' }),
    e => e instanceof ConfigurationError && e.field === 'WORK_REPORT_SCHEDULER_ENABLED' && !e.message.includes('DoNotPrintValue'), JSON.stringify(v));
  assert.throws(() => validateWorkReportScheduler({ WORK_REPORT_SCHEDULER_ENABLED: 'true' }), e => e.field === 'WORK_REPORT_SCHEDULER_START_DATE');
  for (const v of ['2026-02-30', '2026-10-28T00:00', '28/10/2026', '1999-12-31', '2026-1-5']) assert.throws(() => validateWorkReportScheduler({ WORK_REPORT_SCHEDULER_START_DATE: v }), e => e.field === 'WORK_REPORT_SCHEDULER_START_DATE' && !e.message.includes(v), v);
  assert.throws(() => validateRuntimeConfig({ NODE_ENV: 'development', WORK_REPORT_SCHEDULER_ENABLED: 'yes' }), e => e.field === 'WORK_REPORT_SCHEDULER_ENABLED', 'checked at startup before listen');
});

await test('failure classification and bounded backoff: transient retries the same job, everything else is blocked, lease loss writes nothing', () => {
  const E = code => new WR.WorkReportError(409, code, 'x');
  for (const c of ['source_not_settled', 'report_timeout', 'report_conflict', 'period_not_ended']) assert.deepEqual(SCH.classifyFailure(E(c)), { kind: 'transient', code: c });
  for (const c of ['source_clock_unreliable', 'source_coverage_missing', 'source_incomplete', 'report_too_large', 'report_rejected', 'idempotency_conflict', 'rules_version_changed', 'scheduler_epoch_changed', 'cutoff_after_knowledge'])
    assert.deepEqual(SCH.classifyFailure(E(c)), { kind: 'blocked', code: c });
  assert.deepEqual(SCH.classifyFailure(E('lease_lost')), { kind: 'lease_lost', code: 'lease_lost' });
  assert.deepEqual(SCH.classifyFailure(Object.assign(Error('Can\'t reach database server'), { code: 'P1001' })), { kind: 'transient', code: 'db_unavailable' });
  assert.deepEqual(SCH.classifyFailure(Error('boom')), { kind: 'transient', code: 'unexpected_error' });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(SCH.backoffMs), [60e3, 120e3, 240e3, 480e3, 960e3, 1920e3, 3600e3, 3600e3]);
  assert(SCH.MAX_ATTEMPTS >= 3 && SCH.MAX_ATTEMPTS <= 20 && SCH.LEASE_MS > WR.TRANSACTION_TIMEOUT_MS * 2);
});

// A scripted DB for the service guards (the real publication runs on PostgreSQL in the drill).
function fakeDb(handlers) {
  const seen = [];
  const q = async (sql, ...args) => { seen.push(sql); for (const [re, fn] of handlers) if (re.test(sql)) return fn(args, sql); throw Error('unexpected SQL ' + sql.slice(0, 80)); };
  return { seen, $queryRawUnsafe: q, $executeRawUnsafe: q, $transaction: async () => { throw Error('no publication expected'); } };
}
const period = RP.periodFromStart('week', '2026-10-19');
const KEY = WR.scheduledIdempotencyKey(period);
const runningJob = (o = {}) => ({ id: 'wj_1', status: 'running', leaseToken: 'tok', epoch: 1, periodKind: 'week', startDate: '2026-10-19', rulesVersion: RULES_VERSION, idempotencyKey: KEY,
  leaseLive: true, stateEpoch: 1, stateStatus: 'active', coverageSame: true, ...o });
const metaRow = (o = {}) => ({ id: 'wr_00000000-0000-4000-8000-000000000001', periodKind: 'week', startDate: '2026-10-19', endDateExclusive: '2026-10-26', cutoffInstant: '2026-10-25T16:00:00.000000Z',
  knowledgeCutoff: '2026-10-25T16:00:00.000000Z', observedAt: '2026-10-26T00:00:00.000000Z', generatedAt: '2026-10-26T00:00:00.000000Z', rulesVersion: RULES_VERSION, revision: 1,
  generatedById: 9, generatedByName: '主管九', trigger: 'manual', payloadSha256: 'a'.repeat(64), sourceCompleteness: 'insufficient', requestFingerprint: 'f'.repeat(64), ...o });

await test('scheduled key/fingerprint: stable per period and rules version, own domain, valid snapshot key; never lease, attempt, actor or time', () => {
  assert.equal(KEY, WR.scheduledIdempotencyKey(RP.periodFromStart('week', '2026-10-19'))); assert.match(KEY, /^sched-week-20261019-[0-9a-f]{12}$/); assert.match(KEY, /^[A-Za-z0-9_-]{8,100}$/);
  assert.notEqual(WR.scheduledFingerprint(period), WR.generateFingerprint(9, period), 'separate from every manual fingerprint');
  assert.notEqual(WR.scheduledFingerprint(period), WR.scheduledFingerprint(RP.periodFromStart('month', '2026-10-01')));
  assert.equal(WR.scheduledFingerprint.length, 1, 'only the period goes in');
});

await test('generateScheduled guards: lease token, live lease, active epoch, same coverage, rules version, key; replay and skip existing; manual keys cannot use sched-', async () => {
  const S = db => WR.createWorkReportService({ db, readSources: async () => { throw Error('publication must not start'); } });
  const job = o => [/FROM "report_job_runs" j/, () => [runningJob(o)]];
  for (const [o, code] of [[{ leaseToken: 'other' }, 'lease_lost'], [{ leaseLive: false }, 'lease_lost'], [{ status: 'pending' }, 'lease_lost'], [{ stateStatus: 'paused' }, 'scheduler_epoch_changed'],
    [{ stateEpoch: 2 }, 'scheduler_epoch_changed'], [{ coverageSame: false }, 'scheduler_epoch_changed'], [{ coverageSame: null }, 'scheduler_epoch_changed'], [{ rulesVersion: 'work-report.v0' }, 'rules_version_changed'],
    [{ idempotencyKey: 'sched-week-20261019-000000000000' }, 'idempotency_conflict']]) {
    await assert.rejects(S(fakeDb([job(o)])).generateScheduled({ jobId: 'wj_1', leaseToken: 'tok' }), e => e.code === code, JSON.stringify(o));
  }
  await assert.rejects(S(fakeDb([[/FROM "report_job_runs" j/, () => []]])).generateScheduled({ jobId: 'wj_x', leaseToken: 'tok' }), e => e.code === 'lease_lost');
  // the key already published by this job (crash before the job was marked) → same snapshot, replayed; a foreign fingerprint → conflict
  const own = metaRow({ trigger: 'scheduled', generatedById: null, generatedByName: null, requestFingerprint: WR.scheduledFingerprint(period), idempotencyKey: KEY });
  const r = await S(fakeDb([job(), [/"idempotencyKey" = \$1/, () => [own]]])).generateScheduled({ jobId: 'wj_1', leaseToken: 'tok' });
  assert.deepEqual([r.outcome, r.replayed, r.snapshot.id, r.snapshot.generatedByName], ['succeeded', true, own.id, null]);
  await assert.rejects(S(fakeDb([job(), [/"idempotencyKey" = \$1/, () => [metaRow()]]])).generateScheduled({ jobId: 'wj_1', leaseToken: 'tok' }), e => e.code === 'idempotency_conflict');
  // any existing version (here a manual revision 2 on a manual initial) → skipped_existing linked to the real initial version; nothing written
  const v1 = metaRow(), v2 = metaRow({ id: 'wr_00000000-0000-4000-8000-000000000002', revision: 2 });
  const db = fakeDb([job(), [/"idempotencyKey" = \$1/, () => []], [/clock_timestamp\(\) >= \$1/, () => [{ ended: true }]], [/"revision" = 1/, () => [v1]], [/ORDER BY "revision" DESC LIMIT 1/, () => [v2]]]);
  const s = await S(db).generateScheduled({ jobId: 'wj_1', leaseToken: 'tok' });
  assert.deepEqual([s.outcome, s.snapshot.id, s.snapshot.trigger], ['skipped_existing', v1.id, 'manual']); assert(!db.seen.some(x => /INSERT|UPDATE|DELETE/.test(x)), 'read only');
  // reserved prefix for manual requests (after the real admin check)
  const admin = [/FROM "staff"/, () => [{ id: 9, name: '主管九', role: 'admin', active: true, pendingActivation: false, sessionVersion: 3 }]];
  await assert.rejects(S(fakeDb([admin])).generate({ id: 9 }, { sessionVersion: 3 }, { periodKind: 'week', startDate: '2026-10-19', idempotencyKey: KEY }), e => e.code === 'reserved_idempotency_key' && e.status === 400);
  await assert.rejects(S(fakeDb([admin])).revise({ id: 9 }, { sessionVersion: 3 }, v1.id, { idempotencyKey: 'sched-anything-1', reason: '補登', expectedLatestRevision: 1 }), e => e.code === 'reserved_idempotency_key');
  await assert.rejects(S(fakeDb([[/FROM "staff"/, () => [{ id: 9, name: '主管九', role: 'member', active: true, pendingActivation: false, sessionVersion: 3 }]]])).generate({ id: 9 }, { sessionVersion: 3 },
    { periodKind: 'week', startDate: '2026-10-19', idempotencyKey: 'manual-key-0001' }), e => e.code === 'admin_only', 'manual admin check unchanged');
});

await test('HTTP surface: only GET /scheduler/status is added (admin router); no route runs or publishes a scheduled report; sched- keys refused by the schema', async () => {
  const routes = await import(root + '/src/routes/workReports.js');
  const router = routes.createWorkReportsRouter({}, { schedulerStatus: async () => ({}) });
  const list = router.stack.filter(l => l.route).map(l => Object.keys(l.route.methods).map(m => m.toUpperCase() + ' ' + l.route.path)).flat();
  assert.deepEqual(list.sort(), ['GET /', 'GET /:id', 'GET /history', 'GET /periods', 'GET /scheduler/status', 'POST /:id/revisions', 'POST /generate'].sort());   // E4: read-only history review
  assert(router.stack.filter(l => !l.route).length >= 2, 'requireAuth + requireAdmin run before every route');
  const src = fs.readFileSync(root + '/src/routes/workReports.js', 'utf8');
  assert(!/generateScheduled|system\s*:|trigger/.test(src.replace(/\/\/.*$/gm, '')), 'no scheduled entry, system flag or trigger reachable from the API');
  assert(/\.refine\(v => !v\.startsWith\('sched-'\)/.test(src));
});

await test('the worker never starts by itself: import, disabled start and disabled ticks touch no database or timer; a failing tick never throws', async () => {
  const touched = []; const db = new Proxy({}, { get: (_t, k) => (...a) => { touched.push(k); throw Error('database must not be touched'); } });
  const realSetInterval = globalThis.setInterval, realSetTimeout = globalThis.setTimeout; let timers = 0;
  globalThis.setInterval = (...a) => { timers++; return realSetInterval(...a); }; globalThis.setTimeout = (...a) => { timers++; return realSetTimeout(...a); };
  try {
    const off = SCH.createWorkReportScheduler({ db, config: { enabled: false, startDate: null }, log: { log() {}, warn() {} } });
    assert.equal(off.start(), false); assert.deepEqual(await off.tick(), { state: 'disabled' }); assert.equal(timers, 0); assert.deepEqual(touched, []);
  } finally { globalThis.setInterval = realSetInterval; globalThis.setTimeout = realSetTimeout; }
  const warned = [];
  const broken = SCH.createWorkReportScheduler({ db, config: { enabled: true, startDate: '2026-10-28' }, log: { log() {}, warn: m => warned.push(m) } });
  const r = await broken.tick(); assert.equal(r.state, 'error'); assert.equal(warned.length, 1); assert(!/database must not|postgres|DATABASE_URL/i.test(warned[0]), 'only a code is logged');
  assert.throws(() => SCH.createWorkReportScheduler({ db }), /config/);
  const index = fs.readFileSync(root + '/src/index.js', 'utf8');
  assert(/app\.listen\(PORT, \(\) => \{[\s\S]*startWorkReportScheduler\(runtimeConfig\.workReportScheduler\)/.test(index), 'started after listen with the validated config only');
  assert(/try \{ const s = createWorkReportScheduler\(\{ config \}\); s\.start\(\); return s; \}\s*catch/.test(fs.readFileSync(root + '/src/services/workReportScheduler.js', 'utf8')), 'startup failure is caught');
  assert(!/deliver\(|notify|nodemailer|member_notice|releaseNotices/.test(fs.readFileSync(root + '/src/services/workReportScheduler.js', 'utf8')), 'no mail and no member notice from the worker');
});
await test('listen callback keeps the baked MEETING_REMINDERS_ENABLED guard: only "false" disables the meeting loop; the default still starts it; the report scheduler is unaffected', async () => {
  const vm = await import('node:vm');
  const index = fs.readFileSync(root + '/src/index.js', 'utf8');
  const head = 'app.listen(PORT, () => {', at = index.indexOf(head), end = index.indexOf('\n});', at);
  assert(at >= 0 && end > at && index.indexOf(head, at + 1) < 0, 'exactly one listen callback');
  assert.equal(index.match(/startMeetingReminderLoop\(\)/g).length, 1, 'one meeting-loop call site');
  const body = index.slice(at + head.length, end);
  const run = (env) => {
    const calls = [], logs = [];
    vm.runInNewContext(body, {
      process: { env }, PORT: 3000, runtimeConfig: { workReportScheduler: { enabled: false, startDate: null } },
      console: { log: m => logs.push(m) },
      startMeetingReminderLoop: () => calls.push('meeting'), startWorkReportScheduler: c => calls.push(['reports', c.enabled]),
    });
    return { calls, logs };
  };
  const off = run({ MEETING_REMINDERS_ENABLED: 'false' });
  assert.deepEqual(off.calls, [['reports', false]], 'false: no meeting timer, scheduler wiring unchanged');
  assert(off.logs.includes('[meeting-reminder] disabled for migration rehearsal'));
  for (const env of [{}, { MEETING_REMINDERS_ENABLED: 'true' }, { MEETING_REMINDERS_ENABLED: '' }, { MEETING_REMINDERS_ENABLED: 'FALSE' }, { MEETING_REMINDERS_ENABLED: '0' }]) {
    const on = run(env);
    assert.deepEqual(on.calls, ['meeting', ['reports', false]], 'default and any value other than exactly "false" start the loop: ' + JSON.stringify(env));
    assert(!on.logs.some(m => /disabled/.test(m)));
  }
});

console.log(JSON.stringify({ workReportSchedulerTests: passed }));
