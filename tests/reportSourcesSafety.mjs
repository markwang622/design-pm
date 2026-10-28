// REPORTS-P3-E1a: pure checks for src/lib/reportPeriods.js and the reader logic of src/lib/reportSources.js.
// The settle / replay checks here use small stand-ins for the DB; they do NOT replace the real PG18 counter-examples in
// tests/postgresMaintenance.mjs (row-lock ordering, cross-cutoff transactions, settle against real sessions, baseline).
import assert from 'node:assert/strict';
process.env.TZ = 'America/Los_Angeles';   // the helpers must not depend on the host time zone
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const P = await import(root + '/src/lib/reportPeriods.js');
const S = await import(root + '/src/lib/reportSources.js');
const A = await import(root + '/src/services/analytics.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } }
const code = (fn, expected) => { try { fn(); } catch (e) { assert.equal(e.code, expected, e.message); return; } assert.fail('expected ' + expected); };

await test('weeks start Monday (Taipei calendar); ISO week-year labels across the year boundary', () => {
  assert.deepEqual({ ...P.periodContaining('week', '2026-10-27') }, { kind: 'week', startDate: '2026-10-26', endDateExclusive: '2026-11-02', label: '2026-W44' });
  assert.deepEqual({ ...P.periodContaining('week', '2026-11-01') }, { kind: 'week', startDate: '2026-10-26', endDateExclusive: '2026-11-02', label: '2026-W44' }, 'Sunday belongs to the week that started Monday');
  assert.equal(P.periodContaining('week', '2027-01-01').label, '2026-W53', '2026-12-28 … 2027-01-03 is ISO 2026-W53');
  assert.equal(P.periodContaining('week', '2027-01-04').label, '2027-W01');
  assert.equal(P.periodContaining('week', '2025-12-31').label, '2026-W01', '2025-12-29 week belongs to ISO 2026');
  assert.equal(P.periodContaining('week', '2028-01-01').startDate, '2027-12-27');
});
await test('months and quarters are natural calendar periods; half-open date-only membership', () => {
  assert.deepEqual({ ...P.periodContaining('month', '2026-02-28') }, { kind: 'month', startDate: '2026-02-01', endDateExclusive: '2026-03-01', label: '2026-02' });
  assert.equal(P.periodContaining('month', '2026-12-31').endDateExclusive, '2027-01-01');
  assert.deepEqual({ ...P.periodContaining('quarter', '2026-12-31') }, { kind: 'quarter', startDate: '2026-10-01', endDateExclusive: '2027-01-01', label: '2026-Q4' });
  assert.equal(P.periodContaining('quarter', '2027-01-01').label, '2027-Q1');
  const q = P.periodFromStart('quarter', '2026-10-01');
  assert.equal(P.dateInPeriod('2026-10-01', q), true); assert.equal(P.dateInPeriod('2026-12-31', q), true); assert.equal(P.dateInPeriod('2027-01-01', q), false, 'end is exclusive');
  assert.equal(P.nextPeriod(q).startDate, '2027-01-01'); assert.equal(P.previousPeriod(q).startDate, '2026-07-01');
  assert.equal(P.previousPeriod(P.periodFromStart('week', '2027-01-04')).label, '2026-W53');
});
await test('timestamp cutoffs are the real Taipei-midnight instants (UTC 16:00 the day before), microsecond strings', () => {
  const p = P.periodFromStart('week', '2026-10-26');
  assert.deepEqual({ ...P.periodInstants(p) }, { startInstant: '2026-10-25T16:00:00.000000Z', cutoffInstant: '2026-11-01T16:00:00.000000Z' });
  assert.equal(P.periodInstants(P.periodFromStart('quarter', '2026-10-01')).cutoffInstant, '2026-12-31T16:00:00.000000Z');
  assert.equal(P.taipeiDateOf('2026-11-01T15:59:59.999999Z'), '2026-11-01'); assert.equal(P.taipeiDateOf('2026-11-01T16:00:00.000000Z'), '2026-11-02');
  // the old analytics helper carries calendar days as UTC midnight: 8 hours off as an instant, so it is kept separate
  const old = A.resolvePeriod('week', 0, new Date(Date.UTC(2026, 9, 27)));
  assert.equal(old.end.toISOString(), '2026-11-02T00:00:00.000Z'); assert.notEqual(old.end.toISOString().slice(0, 19), P.periodInstants(p).cutoffInstant.slice(0, 19));
});
await test('strict inputs: kinds, real dates, aligned starts, bounded ranges', () => {
  code(() => P.periodContaining('year', '2026-01-01'), 'invalid_period_kind');
  for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '26-01-01', '2026-01-01T00:00:00Z', '', null, '1999-12-31', '2101-01-01']) code(() => P.periodContaining('month', bad), 'invalid_date');
  code(() => P.periodFromStart('week', '2026-10-27'), 'unaligned_period_start');
  code(() => P.periodFromStart('month', '2026-10-02'), 'unaligned_period_start');
  code(() => P.periodFromStart('quarter', '2026-11-01'), 'unaligned_period_start');
  assert.equal(P.listPeriods('month', '2026-01-15', '2026-12-01').length, 12);
  code(() => P.listPeriods('week', '2026-10-01', '2026-01-01'), 'invalid_range');
  code(() => P.listPeriods('week', '2026-01-01', '2027-12-31'), 'range_too_large');
});
await test('normalizeInstant: explicit legal offsets only (±00:00…±14:00, minutes 00–59), microseconds kept, years bounded', () => {
  assert.equal(P.normalizeInstant('2026-10-01T00:00:00+08:00'), '2026-09-30T16:00:00.000000Z');
  assert.equal(P.normalizeInstant('2026-10-01T00:00:00-05:30'), '2026-10-01T05:30:00.000000Z');
  assert.equal(P.normalizeInstant('2026-10-01T00:00:00.123456Z'), '2026-10-01T00:00:00.123456Z');
  assert.equal(P.normalizeInstant('2026-10-01T00:00:00+14:00'), '2026-09-30T10:00:00.000000Z');
  for (const bad of ['2026-10-01T00:00:00+99:99', '2026-10-01T00:00:00+00:60', '2026-10-01T00:00:00+14:30', '2026-10-01T00:00:00+15:00',
    '2026-10-01T00:00:00', '2026-10-01T24:00:00Z', '2026-10-01T00:00:00.1234567Z', '2026-02-30T00:00:00Z', '2100-12-31T23:00:00-08:00', 12345])
    code(() => P.normalizeInstant(bad), bad === '2026-02-30T00:00:00Z' ? 'invalid_date' : 'invalid_instant');
});

// ── reader logic against stand-ins (the real-PG proofs live in postgresMaintenance.mjs) ─────────────────
function fakeTx({ coverageStart = '2026-10-01T00:00:00.000000Z', events = [] } = {}) {
  return { async $queryRawUnsafe(sql, cutoff) {
    if (sql.includes('report_source_coverage')) return coverageStart ? [{ coverageStart, baselineEventMaxId: '1', covered: cutoff >= coverageStart }] : [];
    // emulate: group ALL events per transaction, MAX(capturedAt), select whole transactions with eff < cutoff, order by id
    const eff = new Map(); for (const e of events) eff.set(e.tx, e.at > (eff.get(e.tx) || '') ? e.at : eff.get(e.tx));
    return events.filter(e => eff.get(e.tx) < cutoff).sort((a, b) => a.id - b.id)
      .map(e => ({ id: String(e.id), tableName: e.table, rowKey: e.key, op: e.op, data: e.data, transactionId: String(e.tx) }));
  } };
}
await test('replay: whole transactions by effective time, id order, explicit null kept, D removes, filter only after selection', async () => {
  const at = s => `2026-10-27T00:00:${s}.000000Z`;
  const events = [
    { id: 1, tx: 1, at: at('01'), table: 'cases', key: 'C', op: 'B', data: { id: 'C', title: '甲', copyDate: '2026-10-10' } },
    { id: 2, tx: 2, at: at('02'), table: 'cases', key: 'C', op: 'U', data: { title: '乙' } },
    { id: 3, tx: 3, at: at('03'), table: 'cases', key: 'C', op: 'U', data: { copyDate: null } },
    { id: 4, tx: 4, at: at('04'), table: 'cases', key: 'C', op: 'U', data: { title: '丙' } },     // same transaction as id 5 …
    { id: 5, tx: 4, at: at('09'), table: 'hotels', key: '1', op: 'I', data: { id: 1, name: '館' } }, // … which ends after the cutoff
    { id: 6, tx: 5, at: at('05'), table: 'staff', key: '7', op: 'B', data: { id: 7, name: 'A' } },
    { id: 7, tx: 6, at: at('06'), table: 'staff', key: '7', op: 'D', data: {} },
  ];
  const r = await S.reconstructAt(fakeTx({ events }), at('08'));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.tables.cases.C, { id: 'C', title: '乙', copyDate: null }, 'transaction 4 straddles the cutoff: neither its case nor hotel change is applied');
  assert.equal('copyDate' in r.tables.cases.C, true); assert.deepEqual(r.tables.hotels, {}); assert.deepEqual(r.tables.staff, {});
  const later = await S.reconstructAt(fakeTx({ events }), at('10'));
  assert.equal(later.tables.cases.C.title, '丙'); assert.equal(later.tables.hotels['1'].name, '館');
  const onlyCases = await S.reconstructAt(fakeTx({ events }), at('10'), { tables: ['cases'] });
  assert.deepEqual(Object.keys(onlyCases.tables), ['cases']); assert.equal(onlyCases.transactions, 6, 'table filter applies after whole-transaction selection');
});
await test('replay fails closed on gaps; cutoffs before coverage are insufficient (no fabricated state)', async () => {
  await assert.rejects(S.reconstructAt(fakeTx({ events: [{ id: 1, tx: 1, at: '2026-10-27T00:00:01.000000Z', table: 'cases', key: 'X', op: 'U', data: { title: 'x' } }] }), '2026-10-28T00:00:00Z'), e => e.code === 'source_incomplete');
  await assert.rejects(S.reconstructAt(fakeTx({ events: [{ id: 1, tx: 1, at: '2026-10-27T00:00:01.000000Z', table: 'cases', key: 'X', op: 'D', data: {} }] }), '2026-10-28T00:00:00Z'), e => e.code === 'source_incomplete');
  const r = await S.reconstructAt(fakeTx({ coverageStart: '2026-10-27T00:00:00.000000Z' }), '2026-10-26T16:00:00Z');
  assert.deepEqual(r, { status: 'insufficient', cutoff: '2026-10-26T16:00:00.000000Z', coverageStart: '2026-10-27T00:00:00.000000Z', tables: null });
  await assert.rejects(S.reconstructAt(fakeTx({ coverageStart: null }), '2026-10-28T00:00:00Z'), e => e.code === 'source_coverage_missing');
  await assert.rejects(S.reconstructAt(fakeTx(), '2026-10-28T00:00:00+99:99'), e => e.code === 'invalid_instant');
});
await test('settle is bounded and fail-closed (stand-in observations)', async () => {
  const db = obs => { let i = 0; return { calls: 0, async $transaction(fn) { this.calls++; const o = obs[Math.min(i++, obs.length - 1)];
    return fn({ async $executeRawUnsafe() { return 0; }, async $queryRaw() { return [o]; } }); } }; };
  const ok = { reached: true, prepared: 0, hidden: 0, open: 0 };
  const sleeps = [];
  const d1 = db([{ ...ok, open: 1 }, { ...ok, open: 1 }, ok]);
  assert.equal((await S.settle(d1, '2026-10-27T00:00:00Z', { attempts: 5, delayMs: 7, sleep: ms => sleeps.push(ms) })).settled, true); assert.deepEqual(sleeps, [7, 7]);
  const d2 = db([{ ...ok, open: 2 }]);
  await assert.rejects(S.settle(d2, '2026-10-27T00:00:00Z', { attempts: 3, delayMs: 1, sleep: () => {} }), e => e.code === 'source_not_settled' && e.details.reason === 'open_transactions'); assert.equal(d2.calls, 3);
  for (const [o, reason] of [[{ ...ok, hidden: 1 }, 'activity_not_visible'], [{ ...ok, prepared: 1 }, 'prepared_transactions'], [{ ...ok, reached: false }, 'cutoff_in_future']]) {
    const d = db([o]); await assert.rejects(S.settle(d, '2026-10-27T00:00:00Z', { attempts: 5, sleep: () => {} }), e => e.code === 'source_not_settled' && e.details.reason === reason);
    assert.equal(d.calls, 1, reason + ' cannot resolve by waiting');
  }
});

console.log(JSON.stringify({ passed, failed, liveDatabase: false }));
if (failed) process.exitCode = 1;
