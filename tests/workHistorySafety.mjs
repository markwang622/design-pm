// REPORTS-P4-E4: read-only work history review from current retained data (src/lib/workHistory.js) — the pure builder
// on synthetic current rows, the read path over a recording fake database (RepeatableRead + READ ONLY, parameterised,
// never a write) and the actual admin router over loopback HTTP with in-memory staff. No real database, network or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || decodeURIComponent(new URL('../', import.meta.url).pathname);
const require = createRequire(root + '/package.json');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-work-history-safety-secret';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/never_connect';
const H = await import(root + '/src/lib/workHistory.js');
const RP = await import(root + '/src/lib/reportPeriods.js');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

// ── synthetic current rows (what the read path returns) ─────────────────────────────────────────────────────────
const SEP = RP.periodFromStart('month', '2026-09-01');
const OBS = '2026-10-28T06:30:00.000000Z';
const hotels = [{ id: 1, name: '集團本部', sortOrder: 10, active: true }, { id: 3, name: '新竹館', sortOrder: 20, active: true }, { id: 5, name: '礁溪館', sortOrder: 5, active: false }];
const staff = [{ id: 1, name: '王一', active: true }, { id: 2, name: '陳二', active: false }, { id: 3, name: '林三', active: true }];
const kase = (id, extra = {}) => ({ id, title: 'Case ' + id, hotel: '集團本部', status: 'doing', archived: false, openDate: '2026-08-01', dispatchDate: '2026-08-02', closedOn: null,
  cancelledOn: null, designerId: 1, deliveryMode: 'legacy', deliveryModeSince: null, lifecycleMode: 'legacy', lifecycleStatus: null, requestCount: null, outputCount: null, items: null, logs: null, ...extra });
const dlv = (id, caseId, kind, quantity, unit, deliveredOn, extra = {}) => ({ id, caseId, itemKey: null, itemName: '品項' + id, kind, quantity, unit, deliveredOn,
  createdAt: deliveredOn + 'T03:00:00.000000Z', voidedAt: null, voidReason: null, cycleId: null, note: null, ...extra });
const fixture = () => ({
  observedAt: OBS, hotels, staff,
  cases: [
    // ③ done + closedOn in the period + archived: the closing date is still evidence; archived never removes it
    kase('A', { hotel: '新竹館', status: 'done', closedOn: '2026-09-20', archived: true, requestCount: 4,
      logs: [{ id: 'l1', date: '2026-09-05', note: '=SUM(A1) 初稿' }, { id: 'l1', date: '2026-09-05', note: 'dup same scope' }, { date: '2026-09-06', note: '無 id' },
        { date: '2026-9-7', note: 'bad format' }, { id: 'l9', date: '2026-08-31' }, { id: 'lx', date: '2026-09-31' }, 'not-an-object'],
      items: [{ key: 'itemkey001', n: '主視覺', logs: [{ id: 'l1', date: '2026-09-10', note: '子項目同 id 不同 scope', author: '舊作者' }] },
        { n: '無 key 甲', logs: [{ id: 'k', date: '2026-09-11', text: '舊 text 欄位' }] }, { n: '無 key 乙', logs: [{ id: 'k', date: '2026-09-12' }] }] }),
    kase('B', { deliveryMode: 'records', deliveryModeSince: '2026-08-01T01:00:00.000000Z' }),
    // ③ cancelled now, but a real in-period status change to done remains "有結案紀錄"
    kase('Cx', { hotel: '舊館名', status: 'cancelled', cancelledOn: '2026-10-10' }),
    // ③ sealed now, but a completed cycle ended in the period remains closure evidence
    kase('Dm', { hotel: null, lifecycleMode: 'managed', lifecycleStatus: 'sealed_incomplete' }),
    kase('E', { dispatchDate: '2026-08-15' }),                                                       // inferred, open-ended
    kase('F', { status: 'done', closedOn: null, dispatchDate: '2026-07-01' }),                        // unresolved: closed without end date
    kase('G', { hotel: null, archived: true, dispatchDate: '2026-06-01' }),                           // unresolved: archived, not done, no end
    kase('H', { dispatchDate: '2026-10-01', openDate: '2026-09-30' }),                                // starts at E: not this period
    kase('I', { status: 'closed', closedOn: '2026-08-20' }),                                          // closed before S, no record: out
    kase('J', { lifecycleMode: 'managed', lifecycleStatus: 'active', dispatchDate: '2026-05-01' }),   // sealed gap covers September: out
    kase('L', { lifecycleMode: 'managed', lifecycleStatus: 'active', dispatchDate: '2026-08-01' }),   // pre-adoption legacy part: inferred
    // ① an item log dated in the period on a case dispatched later: still listed (SQL keeps every non-empty container)
    kase('N', { dispatchDate: '2026-10-15', openDate: '2026-10-14', items: [{ key: 'itemkey00N', n: '海報', logs: [{ id: 'n1', date: '2026-09-28', note: '先行打樣' }] }] }),
  ],
  collaborators: [{ caseId: 'A', staffId: 2 }, { caseId: 'A', staffId: 3 }, { caseId: 'A', staffId: 3 }],
  deliveries: [dlv('D1', 'A', 'main', 2, '件', '2026-09-05'), dlv('D1', 'A', 'main', 2, '件', '2026-09-05'), dlv('D2', 'A', 'extension', 3, '份', '2026-09-10', { createdAt: '2026-10-05T01:00:00.000000Z' }),
    dlv('D3', 'A', 'main', 9, '件', '2026-09-11', { voidedAt: '2026-09-12T01:00:00.000000Z', voidReason: '重複登錄' }),
    dlv('S1', 'B', 'support', 0, '件', '2026-09-15', { note: '@僅提供既有檔案', cycleId: 'cy-b' }), dlv('S2', 'B', 'support', 0, '件', '2026-09-16', { cycleId: 'cy-b' }),
    dlv('S3', 'B', 'support', 0, '件', '2026-09-17', { cycleId: 'cy-b' })],
  cycles: [{ id: 'y1', caseId: 'Dm', sequence: 1, source: 'adoption', startedAt: '2026-08-10T02:00:00.000000Z', endedAt: '2026-09-08T02:00:00.000000Z', outcome: 'completed' },
    { id: 'y2', caseId: 'Dm', sequence: 2, source: 'resume', startedAt: '2026-10-05T02:00:00.000000Z', endedAt: '2026-10-10T02:00:00.000000Z', outcome: 'sealed_incomplete' },
    { id: 'j1', caseId: 'J', sequence: 1, source: 'adoption', startedAt: '2026-07-01T02:00:00.000000Z', endedAt: '2026-07-30T02:00:00.000000Z', outcome: 'sealed_incomplete' },
    { id: 'j2', caseId: 'J', sequence: 2, source: 'resume', startedAt: '2026-10-03T02:00:00.000000Z', endedAt: null, outcome: null },
    { id: 'l1', caseId: 'L', sequence: 1, source: 'adoption', startedAt: '2026-10-05T02:00:00.000000Z', endedAt: null, outcome: null }],
  statusChanges: [{ id: 1, caseId: 'Cx', fromValue: 'review_done', toValue: 'done', createdAt: '2026-09-12T03:00:00.000000Z' }],
  submissions: [{ id: 'sub-1', caseId: 'B', recordIds: ['S1'], decision: 'approved', decidedAt: '2026-09-20T01:00:00.000000Z', decidedByName: '主管九', zeroSupportApproved: true },
    { id: 'sub-2', caseId: 'B', recordIds: ['S2'], decision: null, decidedAt: null, decidedByName: null, zeroSupportApproved: null }],
});
const build = (src = fixture(), period = SEP) => H.buildWorkHistory({ period, ...src });
const row = (h, id) => h.rows.find(r => r.id === id);

await test('inclusion: evidence / date-range inference / unresolved kept apart; start ≥ E, closed before S and sealed gaps are out', () => {
  const h = build();
  assert.equal(h.mode, 'retrospective'); assert.equal(h.basis, 'current_retained_data'); assert.equal(h.observedAt, OBS); assert.equal(h.inProgress, false);
  assert.deepEqual(h.notices, ['current_values_not_period_end', 'later_edits_change_result', 'deleted_data_not_restorable', 'not_a_formal_report']);
  assert.deepEqual(h.rows.map(r => [r.id, r.inclusion]).sort(), [['A', 'evidence'], ['B', 'evidence'], ['Cx', 'evidence'], ['Dm', 'evidence'], ['E', 'inferred'], ['L', 'inferred'], ['N', 'evidence']]);
  assert.deepEqual(h.unresolved.map(u => [u.id, u.reason]).sort(), [['F', 'closed_without_end_date'], ['G', 'archived_without_end_date']]);
  assert.deepEqual(row(h, 'E').inferred, { basis: 'dates_open_ended', from: '2026-08-15', to: null }); assert(row(h, 'E').limitations.includes('inferred_from_dates'));
  assert.deepEqual(row(h, 'L').inferred, { basis: 'dates_before_lifecycle_adoption', from: '2026-08-01', to: '2026-10-05' });
  assert.deepEqual(row(h, 'N').evidenceKinds, ['item_log'], '① an in-period item log lists the case even though it was dispatched later');
  assert.deepEqual(h.summary.cases, { evidence: 5, inferred: 2, unresolved: 2 });
});

await test('③ closure evidence: archived done keeps its closedOn; cancelled / sealed now keep real past done-change / completed-cycle records; once per case, not a completion total', () => {
  const h = build();
  assert.deepEqual(row(h, 'A').closure, [{ basis: 'closed_on', date: '2026-09-20' }]); assert(row(h, 'A').current.archived, 'archived is shown as current state only');
  assert.deepEqual(row(h, 'Cx').closure, [{ basis: 'status_change', date: '2026-09-12' }]); assert.equal(row(h, 'Cx').current.status, 'cancelled');
  assert.deepEqual(row(h, 'Cx').statusChanges, [{ from: 'review_done', to: 'done', at: '2026-09-12T03:00:00.000000Z', date: '2026-09-12' }]);
  assert.deepEqual(row(h, 'Dm').closure, [{ basis: 'cycle_completed', date: '2026-09-08' }]); assert(row(h, 'Dm').evidenceKinds.includes('cycle_completed')); assert.equal(row(h, 'Dm').current.lifecycleStatus, 'sealed_incomplete');
  assert.deepEqual(row(h, 'Dm').cycles.map(y => [y.sequence, y.outcome]), [[1, 'completed']], 'only the overlapping cycle');
  assert.deepEqual(row(h, 'E').closure, [], 'an open case has no closure'); assert.deepEqual(h.unresolved.find(u => u.id === 'F').closure, undefined, 'done without a date is unresolved, not closure');
  assert.deepEqual(h.summary.closure, { caseCount: 3, cycleCompleted: 1, statusChange: 1, closedOn: 1 });
  // a cancelled case with a cancelledOn in the period and no done record is never closure; a currently-done case without
  // an in-period date gets no closure for an old period
  const only = build({ ...fixture(), cases: [kase('X', { status: 'cancelled', cancelledOn: '2026-09-15' }), kase('Y', { status: 'done', closedOn: '2026-10-20' })], statusChanges: [], cycles: [], deliveries: [] });
  assert.deepEqual(only.rows.map(r => [r.id, r.inclusion, r.closure.length, r.inferred.basis]), [['X', 'inferred', 0, 'dates_until_cancelled'], ['Y', 'inferred', 0, 'dates_until_closed']]);
  assert.equal(only.summary.closure.caseCount, 0);
  // a cycle completed exactly at S does not overlap [S, C) — its completion event still lies in the period
  const atS = build({ ...fixture(), cases: [kase('W', { lifecycleMode: 'managed', status: 'done', closedOn: '2026-08-31' })], statusChanges: [], deliveries: [],
    cycles: [{ id: 'w1', caseId: 'W', sequence: 1, source: 'adoption', startedAt: '2026-08-01T02:00:00.000000Z', endedAt: '2026-08-31T16:00:00.000000Z', outcome: 'completed' }] });
  assert.deepEqual(row(atS, 'W').cycles, [], 'no overlapping activity'); assert.deepEqual(row(atS, 'W').closure, [{ basis: 'cycle_completed', date: '2026-09-01' }]);
  assert.deepEqual(row(atS, 'W').evidenceKinds, ['cycle_completed']); assert.equal(atS.summary.closure.cycleCompleted, 1);
  const beforeS = build({ ...fixture(), cases: [kase('V', { lifecycleMode: 'managed', status: 'done', closedOn: '2026-08-31' })], statusChanges: [], deliveries: [],
    cycles: [{ id: 'v1', caseId: 'V', sequence: 1, source: 'adoption', startedAt: '2026-08-01T02:00:00.000000Z', endedAt: '2026-08-31T15:59:59.999999Z', outcome: 'completed' }] });
  assert.deepEqual(beforeS.rows, [], 'completed one microsecond before S: not this period');
});

await test('logs: case + nested item logs by valid date, scoped stable-id dedup, id-less kept and flagged, invalid/missing dates counted, aliases kept', () => {
  const a = row(build(), 'A');
  assert.deepEqual(a.progress.map(e => [e.source, e.itemKey, e.id, e.date]), [['case', null, 'l1', '2026-09-05'], ['case', null, null, '2026-09-06'],
    ['item', 'itemkey001', 'l1', '2026-09-10'], ['item', null, 'k', '2026-09-11'], ['item', null, 'k', '2026-09-12']], 'same id in another scope / keyless item is not merged');
  assert.equal(a.progressCount, 5); assert.equal(a.duplicateLogIds, 1); assert.equal(a.logsWithoutId, 1); assert.equal(a.undatedLogCount, 3, '2026-9-7, 2026-09-31, non-object');
  assert.equal(a.progress[0].note, '=SUM(A1) 初稿', 'raw text kept (escaping/CSV guard is the view’s job)');
  assert.equal(a.progress[2].by, '舊作者'); assert.equal(a.progress[3].note, '舊 text 欄位'); assert.equal(a.progress[3].itemName, '無 key 甲');
  for (const l of ['logs_without_id', 'undated_logs']) assert(a.limitations.includes(l), l);
  assert.equal(a.lastActivityDate, '2026-09-20'); assert.equal(row(build(), 'E').lastActivityDate, null, 'inferred rows have no activity date (never a scheduled date)');
});

await test('② preview caps are explicit: every count, summary and total uses all entries; long notes carry a truncation flag', () => {
  const many = Array.from({ length: 205 }, (_, i) => ({ id: 'm' + i, date: '2026-09-' + String(1 + (i % 28)).padStart(2, '0'), note: i === 0 ? 'x'.repeat(H.MAX_NOTE_CHARS + 100) : 'n' + i }));
  const h = build({ ...fixture(), cases: [kase('M', { logs: many })], deliveries: [], cycles: [], statusChanges: [] });
  const m = row(h, 'M');
  assert.equal(m.progress.length, H.MAX_ENTRIES_PER_CASE); assert.equal(m.progressCount, 205); assert.equal(m.progressTruncated, true); assert(m.limitations.includes('progress_truncated'));
  assert.equal(h.summary.progress.entries, 205, 'summary counts every entry, not the preview');
  const long = m.progress.find(e => e.id === 'm0'); assert.equal(long.noteTruncated, true); assert.equal(long.note.length, H.MAX_NOTE_CHARS + 1);
  assert.equal(m.progress.find(e => e.id === 'm1').noteTruncated, false);
  // the latest activity uses every valid in-period log date, not the preview: the 202nd (latest) entry still decides it
  const tail = [...Array.from({ length: 201 }, (_, i) => ({ id: 't' + i, date: '2026-09-01' })), { id: 'late', date: '2026-09-25' }];
  const t = row(build({ ...fixture(), cases: [kase('T', { logs: tail })], deliveries: [], cycles: [], statusChanges: [] }), 'T');
  assert.equal(t.progress.length, H.MAX_ENTRIES_PER_CASE); assert(!t.progress.some(e => e.id === 'late'), 'outside the preview');
  assert.equal(t.lastActivityDate, '2026-09-25', 'sorting / latest activity are independent of the preview cap');
});

await test('deliveries: unique id, voided listed not summed, late-recorded and unknown cycle flagged, kind×unit apart, legacy counts never allocated, support 0 evidence', () => {
  const h = build(), a = row(h, 'A'), b = row(h, 'B');
  assert.deepEqual(a.deliveries.records.map(r => [r.id, r.recordedAfterPeriod, r.cycleAttribution]), [['D1', false, 'unknown'], ['D2', true, 'unknown']]);
  assert.deepEqual(a.deliveries.voided.map(r => [r.id, r.voidReason]), [['D3', '重複登錄']]);
  assert.deepEqual(a.deliveries.totals, [{ kind: 'main', unit: '件', quantity: 2, records: 1 }, { kind: 'extension', unit: '份', quantity: 3, records: 1 }]);
  assert.equal(a.deliveries.status, 'partial', 'legacy case: known part only'); assert.deepEqual(a.legacyCounts, { requestCount: 4, outputCount: null });
  for (const l of ['delivery_recorded_after_period', 'delivery_cycle_attribution_unknown', 'legacy_delivery_mode', 'legacy_counts_period_unknown']) assert(a.limitations.includes(l), l);
  assert.equal(b.deliveries.status, 'recorded');
  assert.deepEqual(b.deliveries.records.map(r => [r.id, r.zeroSupport.status, r.zeroSupport.note]), [['S1', 'approved', '@僅提供既有檔案'], ['S2', 'pending', null], ['S3', 'not_submitted', null]]);
  assert.deepEqual(h.summary.deliveries.groups, [{ kind: 'main', unit: '件', quantity: 2, records: 1, knownSubtotal: 2, total: null },
    { kind: 'extension', unit: '份', quantity: 3, records: 1, knownSubtotal: 3, total: null }, { kind: 'support', unit: '件', quantity: 0, records: 3, knownSubtotal: 0, total: null }]);
  assert.equal(h.summary.deliveries.status, 'partial');
  // a total exists only when every listed case kept records for the whole period and nothing is unresolved
  const full = build({ ...fixture(), cases: [kase('B', { deliveryMode: 'records', deliveryModeSince: '2026-08-01T01:00:00.000000Z' }),
    kase('Q', { deliveryMode: 'records', deliveryModeSince: '2026-08-31T15:59:59.999999Z', logs: [{ id: 'q', date: '2026-09-03' }] })], cycles: [], statusChanges: [] });
  assert.equal(row(full, 'Q').deliveries.status, 'none_recorded', 'records since before S and nothing recorded = a real 0');
  assert.equal(full.summary.deliveries.status, 'complete'); assert.equal(full.summary.deliveries.groups[0].total, 0);
  const late = build({ ...fixture(), cases: [kase('R', { deliveryMode: 'records', deliveryModeSince: '2026-09-10T01:00:00.000000Z', logs: [{ id: 'r', date: '2026-09-03' }] })], deliveries: [], cycles: [], statusChanges: [] });
  assert.equal(row(late, 'R').deliveries.status, 'unknown', 'adopted mid-period: nothing recorded is unknown, never 0'); assert(row(late, 'R').limitations.includes('records_adopted_during_or_after_period'));
  assert.equal(late.summary.deliveries.status, 'partial');
});

await test('current values: hotel order from current sortOrder (inactive, unmatched, none), current owner/collaborators incl. inactive, deduplicated', () => {
  const h = build();
  assert.deepEqual(h.hotelOrder.map(x => x.key), ['hotel:5', 'hotel:1', 'hotel:3', 'unmatched:舊館名', 'none']);
  assert.deepEqual(h.rows.map(r => r.id), ['B', 'E', 'L', 'N', 'A', 'Cx', 'Dm'], 'current hotel order (集團本部 → 新竹館 → unmatched → none), then case id');
  assert.equal(row(h, 'N').hotel.groupKey, 'hotel:1');
  assert.deepEqual(row(h, 'A').current.collaborators, [{ id: 3, name: '林三', active: true }, { id: 2, name: '陳二', active: false }].sort((x, y) => (x.name < y.name ? -1 : 1)));
  assert.deepEqual(row(h, 'A').current.designer, { id: 1, name: '王一', active: true });
  assert.deepEqual(h.staff.map(s => s.id).sort(), [1, 2, 3]);
  const json = JSON.stringify(h); for (const k of ['password', 'email', 'contact', 'requester', 'sessionVersion']) assert(!json.includes(k), k + ' never returned');
});

await test('filter is a pure view of the same read: current hotel / current owner or collaborator; summary recomputed; nothing re-read', () => {
  const h = build();
  const byStaff = H.filterHistory(h, { staffId: 2 });
  assert.deepEqual(byStaff.rows.map(r => r.id), ['A']); assert.deepEqual(byStaff.unresolved, []); assert.equal(byStaff.observedAt, h.observedAt);
  assert.deepEqual(byStaff.filter, { hotel: null, staffId: 2 }); assert.deepEqual(byStaff.summary.cases, { evidence: 1, inferred: 0, unresolved: 0 });
  const none = H.filterHistory(h, { hotel: 'none' });
  assert.deepEqual(none.rows.map(r => r.id), ['Dm']); assert.deepEqual(none.unresolved.map(u => u.id), ['G']);
  assert.equal(none.summary.deliveries.status, 'partial', 'an unresolved case keeps totals unknown');
  assert.deepEqual(H.filterHistory(h, {}).summary, h.summary);
});

await test('in-progress period: marked, read up to observedAt, future-dated log entries are plans (flagged), never period-end', () => {
  const OCT = RP.periodFromStart('month', '2026-10-01');
  const h = build({ ...fixture(), cases: [kase('P', { logs: [{ id: 'p1', date: '2026-10-20' }, { id: 'p2', date: '2026-10-30' }] })], deliveries: [], cycles: [], statusChanges: [] }, OCT);
  assert.equal(h.inProgress, true); assert.deepEqual(row(h, 'P').progress.map(e => e.id), ['p1']); assert(row(h, 'P').limitations.includes('future_dated_logs'));
});

await test('in-progress as-of (root oracle): W44 observed 2026-10-28T04:00Z — a legacy closedOn 10/29 on a closed+archived case and a future-dated delivery have not happened yet', () => {
  const W44 = RP.periodFromStart('week', '2026-10-26'), OBS44 = '2026-10-28T04:00:00.000000Z';
  const h = build({ ...fixture(), observedAt: OBS44, cases: [
    kase('K', { status: 'closed', archived: true, closedOn: '2026-10-29', dispatchDate: '2026-10-20', logs: [{ id: 'f', date: '2026-10-30', note: '未來' }] }),
    kase('T', { status: 'closed', closedOn: '2026-10-28', dispatchDate: '2026-10-20' }),
    kase('U', { deliveryMode: 'records', deliveryModeSince: '2026-01-01T00:00:00.000000Z', dispatchDate: '2026-10-20' })],
    deliveries: [dlv('F1', 'U', 'main', 5, '件', '2026-10-30'), dlv('F0', 'U', 'main', 1, '件', '2026-10-27')], cycles: [], statusChanges: [], submissions: [] }, W44);
  assert.equal(h.inProgress, true);
  const k = row(h, 'K');
  assert.deepEqual(k.closure, [], 'closedOn 10/29 is after the observation day 10/28: no closure so far'); assert(!k.evidenceKinds.includes('closed_on'));
  assert(k.limitations.includes('closed_on_after_observation') && k.limitations.includes('future_dated_logs')); assert.deepEqual(k.progress, []);
  assert.equal(k.inclusion, 'inferred', 'still listed by its dates, honestly'); assert.equal(k.current.status, 'closed', 'current status untouched'); assert.equal(k.current.dates.closedOn, '2026-10-29');
  assert.deepEqual(row(h, 'T').closure, [{ basis: 'closed_on', date: '2026-10-28' }], 'the observation day itself has happened');
  assert.equal(h.summary.closure.caseCount, 1, 'only T (the oracle case K alone gives 0)');
  assert.equal(H.filterHistory(h, { hotel: 'hotel:1' }).summary.closure.caseCount, 1);
  const only = build({ ...fixture(), observedAt: OBS44, cases: [kase('K', { status: 'closed', archived: true, closedOn: '2026-10-29', dispatchDate: '2026-10-20' })], deliveries: [], cycles: [], statusChanges: [] }, W44);
  assert.equal(only.summary.closure.caseCount, 0, 'root oracle: summary.closure.caseCount = 0');
  const u = row(h, 'U');
  assert.deepEqual(u.deliveries.records.map(r => r.id), ['F0'], 'the 10/30 delivery has not happened yet'); assert(u.limitations.includes('future_dated_deliveries'));
  assert.deepEqual(h.summary.deliveries.groups.map(g => [g.kind, g.unit, g.knownSubtotal]), [['main', '件', 1]]);
});

// ── read path: RepeatableRead + READ ONLY, parameterised candidate superset, no writes ─────────────────────────────
function fakeDb(src = fixture(), { observedAt = OBS, cases, budget } = {}) {
  const log = { queries: [], executes: [], opts: null };
  const tx = {
    async $executeRawUnsafe(sql) { log.executes.push(sql); if (sql !== 'SET TRANSACTION READ ONLY') throw Error('write attempted: ' + sql); return 0; },
    async $queryRawUnsafe(sql, ...params) {
      log.queries.push({ sql, params });
      if (/INSERT|UPDATE |DELETE|TRUNCATE|nextval|pg_advisory/i.test(sql)) throw Error('write attempted');
      if (/clock_timestamp/.test(sql)) return [{ observedAt }];
      if (/FROM "hotels"/.test(sql)) return src.hotels;
      if (/count\(\*\)/.test(sql)) return [budget ?? { cases: (cases ?? src.cases).length, jsonBytes: '1024' }];
      if (/FROM "cases" c/.test(sql)) return cases ?? src.cases;
      if (/FROM "_collaborators"/.test(sql)) return src.collaborators;
      if (/FROM "staff"/.test(sql)) return src.staff;
      if (/FROM "case_deliveries"/.test(sql)) return src.deliveries;
      if (/FROM "case_cycles"/.test(sql)) return src.cycles;
      if (/FROM "change_logs"/.test(sql)) return src.statusChanges;
      if (/FROM "case_delivery_submissions"/.test(sql)) return src.submissions;
      throw Error('unexpected query ' + sql);
    },
  };
  return { log, db: { async $transaction(fn, opts) { log.opts = opts; return fn(tx); }, $executeRawUnsafe() { throw Error('outside tx'); }, $queryRawUnsafe() { throw Error('outside tx'); } } };
}

await test('service: one RepeatableRead READ ONLY transaction, ≤ 10 parameterised SELECTs (no N+1), SQL is a superset (any non-empty log container), budget pre-check, no write', async () => {
  const { db, log } = fakeDb();
  const h = await H.createWorkHistoryService({ db }).read('month', '2026-09-01');
  assert.equal(log.opts.isolationLevel, 'RepeatableRead'); assert.deepEqual(log.executes, ['SET TRANSACTION READ ONLY']);
  assert(log.queries.length <= 10, 'bounded queries: ' + log.queries.length);
  const pre = log.queries.findIndex(q => /count\(\*\)/.test(q.sql)), load = log.queries.findIndex(q => /FROM "cases" c/.test(q.sql) && !/count\(\*\)/.test(q.sql));
  assert(pre >= 0 && pre < load, 'count + raw JSON bytes are checked before any case JSON is loaded');
  assert(/octet_length\(c\."logs"::text\)/.test(log.queries[pre].sql) && /octet_length\(c\."items"::text\)/.test(log.queries[pre].sql));
  assert.deepEqual(log.queries[pre].params, log.queries[load].params, 'the pre-check and the load share the same candidate condition and parameters');
  const cand = log.queries[load];
  assert.deepEqual(cand.params, ['2026-09-01', '2026-10-01', '2026-08-31T16:00:00.000000Z', '2026-09-30T16:00:00.000000Z'], 'dates are parameters, never interpolated');
  assert(/c\."logs" IS NOT NULL AND c\."logs" NOT IN/.test(cand.sql) && /c\."items" IS NOT NULL AND c\."items" NOT IN/.test(cand.sql), '① every non-empty case/item log container is a candidate');
  assert(!/jsonb_path|@\.date/.test(cand.sql), 'no lexical date judgement in SQL');
  assert(/c\."closedOn" IS NOT NULL AND c\."closedOn" < \$1::date/.test(cand.sql), 'a done case without closedOn is not dropped in SQL (stays unresolved)');
  assert(!/"email"|"password"|"contact"|"requester"|"note" FROM "cases"/.test(log.queries.map(q => q.sql).join('\n')), 'whitelisted columns only');
  assert(log.queries.every(q => /^\s*SELECT/.test(q.sql)));
  assert.deepEqual(h.summary.cases, build().summary.cases, 'the service result is the pure builder over the same read');
  const early = fakeDb(fixture(), { observedAt: '2026-08-31T15:59:59.999999Z' });
  await assert.rejects(H.createWorkHistoryService({ db: early.db }).read('month', '2026-09-01'), e => e.status === 422 && e.code === 'period_not_started');
  for (const budget of [{ cases: H.MAX_HISTORY_CASES + 1, jsonBytes: '10' }, { cases: 10, jsonBytes: String(H.MAX_SOURCE_JSON_BYTES + 1) }]) {
    const big = fakeDb(fixture(), { budget });
    await assert.rejects(H.createWorkHistoryService({ db: big.db }).read('month', '2026-09-01'), e => e.status === 422 && e.code === 'history_too_large', 'never a silent cut');
    assert(!big.log.queries.some(q => /c\."items", c\."logs"/.test(q.sql)), 'over budget: the JSON load never runs');
  }
  const big = fakeDb(fixture(), { cases: Array.from({ length: H.MAX_HISTORY_CASES + 1 }, (_, i) => kase('Z' + i)) });
  await assert.rejects(H.createWorkHistoryService({ db: big.db }).read('month', '2026-09-01'), e => e.status === 422 && e.code === 'history_too_large', 'row guard as well');
  assert.equal(H.MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
  assert(/Buffer\.byteLength\(JSON\.stringify\(payload\)\) > MAX_RESPONSE_BYTES\) throw tooLarge\(\)/.test(fs.readFileSync(root + '/src/lib/workHistory.js', 'utf8')), 'response cap');
  await assert.rejects(H.createWorkHistoryService({ db }).read('month', '2026-09-02'), e => e.name === 'PeriodError');
  const src = fs.readFileSync(root + '/src/lib/workHistory.js', 'utf8').replace(/\/\/.*$/gm, '');
  assert(!/buildWorkReportPayload|report_snapshots|report_source|INSERT|UPDATE "|DELETE FROM/.test(src), 'no snapshot chain, no coverage, no write');
});

// ── route: the actual admin router over loopback HTTP ─────────────────────────────────────────────────────────────
await test('route: GET /history is admin-only (401 / 403 / observer 403), strict query, no-store, declared before /:id, never calls the snapshot service', async () => {
  const express = require('express'), cookieParser = require('cookie-parser');
  const { prisma } = await import(root + '/src/lib/db.js');
  const { signToken } = await import(root + '/src/middleware/auth.js');
  const people = { 1: { id: 1, name: 'Admin', email: 'a@fixture.invalid', role: 'admin', active: true, pendingActivation: false, sessionVersion: 0 },
    2: { id: 2, name: 'Member', email: 'm@fixture.invalid', role: 'member', active: true, pendingActivation: false, sessionVersion: 0 },
    4: { id: 4, name: 'Observer', email: 'o@fixture.invalid', role: 'observer', active: true, pendingActivation: false, sessionVersion: 0 } };
  prisma.staff.findUnique = async ({ where }) => structuredClone(people[where.id] || null);
  const reads = [], snapshotCalls = [];
  const snapshotService = new Proxy({}, { get: (_t, k) => (...a) => { snapshotCalls.push(k); throw Error('snapshot service must not be used'); } });
  const { createWorkReportsRouter } = await import(root + '/src/routes/workReports.js');
  const router = createWorkReportsRouter(snapshotService, { schedulerStatus: async () => ({}), history: { read: async (k, s) => { reads.push([k, s]); return build(); } } });
  const paths = router.stack.filter(l => l.route).map(l => l.route.path);
  assert(paths.indexOf('/history') >= 0 && paths.indexOf('/history') < paths.indexOf('/:id'), '/history is matched before /:id');
  const app = express(); app.use(cookieParser()); app.use('/api/work-reports', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/work-reports';
  const get = async (q, id, method = 'GET') => { const r = await fetch(base + q, { method, headers: id ? { Cookie: 'designpm_token=' + signToken({ id, sessionVersion: 0 }) } : {} }); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) }; };
  try {
    assert.equal((await get('/history?kind=month&start=2026-09-01')).status, 401);
    assert.equal((await get('/history?kind=month&start=2026-09-01', 2)).status, 403, 'member');
    assert.equal((await get('/history?kind=month&start=2026-09-01', 4)).status, 403, 'observer');
    const ok = await get('/history?kind=month&start=2026-09-01', 1);
    assert.equal(ok.status, 200); assert.equal(ok.cache, 'no-store'); assert.equal(ok.body.mode, 'retrospective'); assert.deepEqual(reads, [['month', '2026-09-01']]);
    for (const q of ['/history?kind=month&start=2026-09-01&hotel=x', '/history?kind=year&start=2026-09-01', '/history?kind=month', '/history?kind=month&start=2026-9-1', '/history?kind=month&start=2026-09-01&role=admin'])
      assert.equal((await get(q, 1)).status, 400, q);
    assert.equal((await get('/history?kind=month&start=2026-09-01', 1, 'POST')).status, 404, 'no write verb');
    assert.equal(reads.length, 1); assert.deepEqual(snapshotCalls, [], 'never touches the snapshot service');
  } finally { server.close(); }
});

console.log(JSON.stringify({ workHistoryTests: passed, liveDatabase: false }));
