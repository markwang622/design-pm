// REPORTS-P3-E1b: pure work-report payload rules on synthetic C/K source projections (no DB). These are the business-number
// fixtures (seal/resume gaps, void + backfill, logs, collaboration, coverage branches); the real PG drill covers publication,
// auth, concurrency, immutability and restore on actual sources (whose ended periods are necessarily before coverage).
import assert from 'node:assert/strict';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const P = await import(root + '/src/lib/workReportPayload.js');
const { periodFromStart, periodInstants } = await import(root + '/src/lib/reportPeriods.js');
const { generateFingerprint, revisionFingerprint, pgCode, serializeMeta } = await import(root + '/src/lib/workReports.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const plain = v => JSON.parse(JSON.stringify(v));
const week = periodFromStart('week', '2026-10-19');
const { startInstant: S, cutoffInstant: C } = periodInstants(week);   // 2026-10-18T16:00Z / 2026-10-25T16:00Z
const K = '2026-10-27T16:00:00.000000Z';
const EMPTY = ['cases', '_collaborators', 'case_deliveries', 'case_cycles', 'case_lifecycle_requests', 'case_schedule_requests', 'case_delivery_submissions', 'staff', 'hotels', 'change_logs'];
function state(parts, { coverageStart = '2026-01-01T00:00:00.000000Z', maxEventId = '100' } = {}) {
  const tables = Object.fromEntries(EMPTY.map(t => [t, {}]));
  for (const [t, rows] of Object.entries(parts)) for (const r of rows) tables[t][t === '_collaborators' ? r.caseId + ':' + r.staffId : String(r.id)] = r;
  return { status: 'ok', coverageStart, maxEventId, tables };
}
const staff = [{ id: 1, name: '王一', role: 'member', active: true, departedOn: null }, { id: 2, name: '陳二', role: 'member', active: true, departedOn: null },
  { id: 3, name: '林三', role: 'member', active: true, departedOn: null }, { id: 4, name: '張四', role: 'member', active: true, departedOn: null },
  { id: 9, name: '主管九', role: 'admin', active: true, departedOn: null }];
const hotels = [{ id: 1, region: '集團', name: '集團本部', sortOrder: 10, active: true }, { id: 3, region: '新竹', name: '新竹館', sortOrder: 20, active: true },
  { id: 2, region: '宜蘭', name: '礁溪館', sortOrder: 20, active: false }];
const kase = (id, extra = {}) => ({ id, title: 'Case ' + id, subTitle: null, requester: 'R', hotel: '集團本部', level: 'A', category: null, status: 'doing', urgent: false,
  openDate: '2026-10-01', requestedOn: null, dispatchDate: '2026-10-02', copyDate: null, printDate: null, goLiveDate: '2026-11-30', closedOn: null, cancelledOn: null,
  cancelReason: null, cancelStage: null, archived: false, designerId: 1, deliveryMode: 'legacy', scheduleMode: 'legacy', scheduleBaseline: null, lifecycleMode: 'legacy',
  lifecycleStatus: null, currentCycleId: null, pendingDeliverySubmissionId: null, pendingScheduleRequestId: null, pendingLifecycleRequestId: null, requestCount: null,
  outputCount: null, items: null, logs: null, contentVersion: 0, createdAt: '2026-10-01T01:00:00', updatedAt: '2026-10-01T01:00:00', ...extra });
const dlv = (id, caseId, kind, quantity, deliveredOn, extra = {}) => ({ id, caseId, itemKey: null, itemName: '品項 ' + id, kind, quantity, unit: '件', deliveredOn, note: null,
  recordedById: 1, recordedByName: '王一', createdAt: '2026-10-20T01:00:00', cycleId: null, voidedAt: null, voidedById: null, voidedByName: null, voidReason: null, ...extra });
const cycle = (id, caseId, sequence, startedAt, endedAt, outcome) => ({ id, caseId, sequence, source: sequence === 1 ? 'adoption' : 'resume', startedAt, startedById: 9,
  startedByName: '主管九', startReason: '導入', startRequestId: 'req-' + id, startSnapshot: {}, endedAt, outcome, endedById: endedAt ? 9 : null, endedByName: endedAt ? '主管九' : null,
  endReason: null, endRequestId: null, endSnapshot: endedAt ? { activeDeliveryIds: ['R0', 'R1', 'R2'] } : null });
const build = (end, know, extra = {}) => P.buildWorkReportPayload({ period: week, cutoff: C, knowledgeCutoff: extra.K ?? C, observedAt: extra.observedAt ?? (extra.K ?? C),
  coverageStart: end.coverageStart, revision: extra.revision ?? 1, supersedesId: extra.supersedesId ?? null, revisionReason: extra.revisionReason ?? null,
  generatedBy: { id: 9, name: '主管九' }, trigger: 'manual', endState: end, knowledge: know, deletedCaseIds: extra.deletedCaseIds });
const row = (payload, id) => payload.rows.find(r => r.id === id);
const totals = list => Object.fromEntries(list.map(g => [g.kind + '/' + g.unit, g.quantity]));

await test('canonical JSON sorts keys at every level, keeps null and array order, and refuses undefined', () => {
  assert.equal(P.canonicalJson({ b: [3, { y: null, x: 1 }], a: '台' }), '{"a":"台","b":[3,{"x":1,"y":null}]}');
  assert.equal(P.payloadSha256({ a: 1, b: { c: 2 } }), P.payloadSha256({ b: { c: 2 }, a: 1 }));
  assert.notEqual(P.payloadSha256({ a: [1, 2] }), P.payloadSha256({ a: [2, 1] }));
  assert.throws(() => P.canonicalJson({ a: undefined }), /undefined/); assert.throws(() => P.canonicalJson({ a: NaN }), /non-finite/);
});

await test('coverage branches: insufficient keeps rows empty and every count null; partial reports known subtotals only; complete gives totals', () => {
  const insufficient = P.buildWorkReportPayload({ period: week, cutoff: C, knowledgeCutoff: C, observedAt: C, coverageStart: '2026-10-27T00:00:00.000000Z', revision: 1,
    generatedBy: { id: 9, name: '主管九' }, trigger: 'manual', endState: { status: 'insufficient', coverageStart: '2026-10-27T00:00:00.000000Z', tables: null }, knowledge: null });
  assert.deepEqual(insufficient.rows, []); assert.equal(insufficient.sourceCompleteness.status, 'insufficient');
  assert.deepEqual(insufficient.sourceCompleteness, { status: 'insufficient', coverageStart: '2026-10-27T00:00:00.000000Z', endStateCovered: false, periodCovered: false,
    knowledgeCovered: false, reasons: ['end_state_before_coverage'], deletedCaseIds: [] });
  for (const k of ['caseCount', 'activeCaseCount', 'completedInPeriod']) assert.deepEqual(insufficient.summary[k], { knownSubtotal: null, total: null }, k);
  assert.deepEqual(insufficient.summary.deliveries, { period: [], status: 'unknown' });
  // S < coverage ≤ C: legacy L (outputCount null) and records case R whose only in-period delivery was voided
  const parts = { staff, hotels, cases: [kase('L-1'), kase('R-1', { deliveryMode: 'records' }), kase('R-2', { deliveryMode: 'records' })],
    case_deliveries: [dlv('d-void', 'R-1', 'main', 2, '2026-10-20', { voidedAt: '2026-10-21T01:00:00', voidReason: '重複' }), dlv('d-ok', 'R-2', 'main', 1, '2026-10-22')] };
  const partialState = state(parts, { coverageStart: '2026-10-21T00:00:00.000000Z' });
  const partial = build(partialState, partialState);
  assert.equal(partial.sourceCompleteness.status, 'partial'); assert.deepEqual(partial.sourceCompleteness.reasons, ['period_start_before_coverage']);
  assert.equal(row(partial, 'L-1').deliveries.status, 'unknown'); assert.deepEqual(row(partial, 'L-1').deliveries.legacyCounts, { requestCount: null, outputCount: null, periodAttribution: 'unknown' });
  assert.equal(row(partial, 'R-1').deliveries.status, 'none_recorded'); assert.deepEqual(row(partial, 'R-1').deliveries.period.records, []);
  assert.deepEqual(partial.summary.caseCount, { knownSubtotal: 3, total: null });
  assert.deepEqual(partial.summary.deliveries.period.map(g => [g.kind, g.knownSubtotal, g.total]), [['main', 1, null]]);
  const complete = build(state(parts), state(parts));
  assert.equal(complete.sourceCompleteness.status, 'complete');
  assert.deepEqual(complete.summary.caseCount, { knownSubtotal: 3, total: 3 });
  assert.equal(complete.summary.deliveries.period[0].total, null, 'a legacy case with unknown output keeps the department total unknown');
  const recordsOnly = build(state({ ...parts, cases: parts.cases.slice(1) }), state({ ...parts, cases: parts.cases.slice(1) }));
  assert.deepEqual(recordsOnly.summary.deliveries.period.map(g => [g.kind, g.knownSubtotal, g.total]), [['main', 1, 1]]);
  assert.deepEqual(recordsOnly.summary.deliveryStatusCounts, { known: 1, none_recorded: 1, unknown: 0, partial: 0 });
});

await test('sealed / completed / archived / cancelled: end state and completion events stay separate from delivered work', () => {
  const parts = { staff, hotels, cases: [
    kase('A', { lifecycleMode: 'managed', lifecycleStatus: 'sealed_incomplete', status: 'doing', archived: true, deliveryMode: 'records' }),
    kase('B', { status: 'closed', archived: true, closedOn: '2026-10-21' }),
    kase('C', { status: 'wait', archived: true }),
    kase('D', { status: 'cancelled', cancelledOn: '2026-10-22', cancelReason: '需求取消', deliveryMode: 'records' }),
    kase('E', { status: 'closed', closedOn: '2026-10-12' }), kase('F', { status: 'done', closedOn: null })],
    case_cycles: [cycle('cy-a1', 'A', 1, '2026-10-01T01:00:00', '2026-10-22T03:00:00', 'sealed_incomplete')],
    case_deliveries: [dlv('a-1', 'A', 'main', 2, '2026-10-20'), dlv('d-1', 'D', 'main', 1, '2026-10-21')] };
  const p = build(state(parts), state(parts));
  assert.deepEqual([row(p, 'A').endState.kind, row(p, 'A').completion.state, row(p, 'A').activity.state, row(p, 'A').nextStep.code], ['sealed_incomplete', 'no', 'yes', 'may_request_resume']);
  assert.deepEqual(totals(row(p, 'A').deliveries.period.totals), { 'main/件': 2 });
  assert.deepEqual([row(p, 'B').endState.kind, row(p, 'B').completion.state], ['completed', 'yes']);
  assert.equal(row(p, 'C'), undefined, 'archived legacy without dates is not proven in progress');
  assert.deepEqual(p.unresolved.map(u => [u.id, u.activity.basis]), [['C', 'legacy_archived_without_end_date'], ['F', 'legacy_missing_end_date']]);
  assert.deepEqual([row(p, 'D').endState.kind, row(p, 'D').completion.state, row(p, 'D').nextStep.code], ['cancelled', 'no', 'none_cancelled']);
  assert.deepEqual(totals(row(p, 'D').deliveries.period.totals), { 'main/件': 1 }, 'delivered work of a cancelled case stays');
  assert.equal(row(p, 'E'), undefined, 'closed before the period: not in progress, not a completion of this period');
  assert.deepEqual(p.summary.completedInPeriod, { knownSubtotal: 1, total: null }, 'unknown completions keep the total unknown');
  const known = build(state({ ...parts, cases: parts.cases.filter(c => !['C', 'F'].includes(c.id)) }), state({ ...parts, cases: parts.cases.filter(c => !['C', 'F'].includes(c.id)) }));
  assert.deepEqual(known.summary.completedInPeriod, { knownSubtotal: 1, total: 1 });
});

await test('several cycles and seal gaps: half-open cycle intersection, one row per case, K resume never rewrites the C end state', () => {
  const parts = { staff, hotels, cases: [kase('X', { lifecycleMode: 'managed', lifecycleStatus: 'sealed_incomplete', archived: true, deliveryMode: 'records', currentCycleId: 'cy-2' })],
    case_cycles: [cycle('cy-1', 'X', 1, '2026-09-30T16:00:00', '2026-10-09T16:00:00', 'sealed_incomplete'), cycle('cy-2', 'X', 2, '2026-10-19T16:00:00', '2026-10-22T16:00:00', 'sealed_incomplete')],
    case_deliveries: [dlv('R0', 'X', 'main', 1, '2026-10-05'), dlv('R1', 'X', 'main', 2, '2026-10-08', { cycleId: 'cy-1' }), dlv('R2', 'X', 'extension', 3, '2026-10-21', { cycleId: 'cy-2' })] };
  const gap = periodFromStart('week', '2026-10-12'), g = periodInstants(gap);
  const gapPayload = P.buildWorkReportPayload({ period: gap, cutoff: g.cutoffInstant, knowledgeCutoff: g.cutoffInstant, observedAt: g.cutoffInstant, coverageStart: '2026-01-01T00:00:00.000000Z',
    revision: 1, trigger: 'manual', endState: state(parts), knowledge: state(parts) });
  assert.deepEqual(gapPayload.rows, [], 'a sealed gap with no evidence is not in progress'); assert.deepEqual(gapPayload.unresolved, []);
  const p = build(state(parts), state(parts));
  assert.equal(p.rows.length, 1); assert.deepEqual([row(p, 'X').activity.state, row(p, 'X').activity.basis], ['yes', 'managed_cycles']);
  assert.deepEqual(totals(row(p, 'X').deliveries.period.totals), { 'extension/件': 3 });
  assert.deepEqual(totals(row(p, 'X').deliveries.cumulativeToEnd.totals), { 'main/件': 3, 'extension/件': 3 }, 'records only, never cycle snapshots');
  assert.equal(p.summary.caseCount.knownSubtotal, 1);
  // boundaries: a cycle ending exactly at S or starting exactly at C does not intersect
  const edge = c2 => build(state({ ...parts, case_deliveries: [], case_cycles: c2 }), state({ ...parts, case_deliveries: [], case_cycles: c2 }));
  assert.deepEqual(edge([cycle('e1', 'X', 1, '2026-10-01T00:00:00', S.slice(0, 26), 'sealed_incomplete')]).rows, []);
  assert.deepEqual(edge([cycle('e1', 'X', 1, '2026-10-01T00:00:00', '2026-10-05T00:00:00', 'sealed_incomplete'), cycle('e2', 'X', 2, C.slice(0, 26), null, null)]).rows, []);
  assert.equal(edge([cycle('e1', 'X', 1, '2026-10-01T00:00:00', S.slice(0, 19) + '.000001', 'sealed_incomplete')]).rows.length, 1, 'one microsecond inside intersects');
  // revision at K: cycle 3 resumed after C, case reactivated, renamed and reassigned — the row still shows C
  const kParts = { ...parts, cases: [kase('X', { ...parts.cases[0], lifecycleStatus: 'active', archived: false, status: 'doing', currentCycleId: 'cy-3', title: '改名後', designerId: 4 })],
    case_cycles: [...parts.case_cycles, cycle('cy-3', 'X', 3, '2026-10-26T16:00:00', null, null)] };
  const v2 = build(state(parts), state(kParts), { K, revision: 2, supersedesId: 'wr_parent', revisionReason: '補登更正' });
  assert.deepEqual([row(v2, 'X').endState.kind, row(v2, 'X').nextStep.code, row(v2, 'X').title, row(v2, 'X').assignment.designer.id], ['sealed_incomplete', 'may_request_resume', 'Case X', 1]);
  // adoption inside the period with nothing before it: pre-adoption time is unknown, not "no"
  const late = { ...parts, case_deliveries: [], case_cycles: [cycle('l1', 'X', 1, '2026-10-26T01:00:00', null, null)] };
  assert.equal(build(state(late), state(late)).rows.length, 0);
});

await test('void, correction and backfill: v1 = C, v2 = K-known deliveries with labels; nothing after the period leaks into cumulative', () => {
  const cParts = { staff, hotels, cases: [kase('V', { deliveryMode: 'records', designerId: 1 })], case_deliveries: [dlv('R1', 'V', 'main', 2, '2026-10-25')] };
  const kParts = { staff: staff.map(s => s.id === 2 ? { ...s, name: '陳二（改名）' } : s), hotels, cases: [kase('V', { deliveryMode: 'records', designerId: 4, title: '改名', status: 'review' })],
    case_deliveries: [dlv('R1', 'V', 'main', 2, '2026-10-25', { voidedAt: '2026-10-26T03:00:00', voidReason: '數量更正' }), dlv('R2', 'V', 'main', 3, '2026-10-25', { createdAt: '2026-10-26T03:00:00' }),
      dlv('R3', 'V', 'main', 5, '2026-10-26')] };
  const v1 = build(state(cParts), state(cParts));
  const v1Hash = P.payloadSha256(v1);
  assert.deepEqual(totals(row(v1, 'V').deliveries.period.totals), { 'main/件': 2 });
  const v2 = build(state(cParts), state(kParts), { K, revision: 2, supersedesId: 'wr_v1', revisionReason: '交付數量更正' });
  const r = row(v2, 'V');
  assert.deepEqual(totals(r.deliveries.period.totals), { 'main/件': 3 });
  assert.deepEqual(r.deliveries.period.records.map(d => [d.id, d.knowledge]), [['R2', 'recorded_after_cutoff']]);
  assert.deepEqual(r.deliveries.voidedAfterCutoff.map(d => [d.id, d.knowledge, d.voidReason]), [['R1', 'voided_after_cutoff', '數量更正']]);
  assert.deepEqual(totals(r.deliveries.cumulativeToEnd.totals), { 'main/件': 3 }, 'R3 (delivered on E) belongs to the next period');
  assert.deepEqual([r.title, r.endState.status, r.assignment.designer.id], ['Case V', 'doing', 1], 'status / title / assignment from C');
  assert.deepEqual([v2.meta.knowledgeCutoff, v2.meta.sources.knowledge, v2.meta.revision, v2.meta.supersedesId], [K, 'knowledge_cutoff', 2, 'wr_v1']);
  assert.equal(P.payloadSha256(v1), v1Hash, 'building v2 never touches v1');
  // a case created after C with a backdated delivery in the period: labelled K identity, no invented C state
  const kNew = { ...kParts, cases: [...kParts.cases, kase('N', { deliveryMode: 'records', hotel: '新竹館', designerId: 3 }), kase('Q', { deliveryMode: 'records' })],
    case_deliveries: [...kParts.case_deliveries, dlv('N1', 'N', 'support', 1, '2026-10-20')] };
  const v3 = build(state(cParts), state(kNew), { K, revision: 2, supersedesId: 'wr_v1', revisionReason: '補登案件' });
  const n = row(v3, 'N');
  assert.deepEqual([n.identityBasis, n.endState.kind, n.hotel.groupKey, n.hotel.raw, n.assignment.basis, n.limitations], ['knowledge_cutoff', 'not_recorded_at_cutoff', 'not_recorded_at_cutoff', '新竹館', 'knowledge_cutoff', ['recorded_after_cutoff']]);
  assert.equal(row(v3, 'Q'), undefined, 'a K-only case without period activity is not brought in');
  assert.equal(v3.hotelOrder.at(-1).key, 'not_recorded_at_cutoff');
});

await test('logs and items: stable-id comparison, unidentified legacy entries, aliases kept, item completion never counts as output', () => {
  const cLogs = [{ id: 'log-a-0001', date: '2026-10-23', note: '初稿', by: '王一' }, { id: 'log-z-0001', date: '2026-10-20', note: '後來刪掉', by: '王一' }, { date: '2026-10-21', text: '舊式匯出', author: '林三' }];
  const kLogs = [{ id: 'log-b-0001', date: '2026-10-24', note: '需求確認', by: '陳二' }, { id: 'log-a-0001', date: '2026-10-23', note: '已核稿', by: '王一' },
    { date: '2026-10-21', text: '舊式匯出', author: '林三' }, { id: 'log-o-0001', date: '2026-10-30', note: '期後' }, { note: '無日期' }];
  const items = logs => [{ key: 'item-key-0001', n: '主視覺', status: '已完成', logs }, { key: 'item-key-0002', n: '海報', status: '製作中', logs: [{ date: '2026-10-22', note: '子案進度' }] }];
  const cParts = { staff, hotels, cases: [kase('G', { deliveryMode: 'records', logs: cLogs, items: items([{ date: '2026-10-22', note: '子案初稿' }]) })] };
  const kParts = { staff, hotels, cases: [kase('G', { deliveryMode: 'records', logs: kLogs, items: items([{ date: '2026-10-22', note: '子案初稿（改）' }]) })] };
  const v1 = build(state(cParts), state(cParts));
  assert(row(v1, 'G').progress.every(e => e.knowledge === 'as_of_cutoff'));
  assert.deepEqual(row(v1, 'G').progress.find(e => e.source === 'case' && e.id === null).entry, { date: '2026-10-21', text: '舊式匯出', author: '林三' }, 'original fields kept');
  assert.equal(row(v1, 'G').progress.find(e => e.id === null && e.source === 'case').note, '舊式匯出');
  const v2 = build(state(cParts), state(kParts), { K, revision: 2, supersedesId: 'wr_v1', revisionReason: '日誌補登' });
  const g = row(v2, 'G'), by = Object.fromEntries(g.progress.map(e => [(e.id ?? e.source + ':' + (e.itemKey ?? '') + ':' + e.note), e.knowledge]));
  assert.deepEqual(by, { 'log-a-0001': 'corrected_after_cutoff', 'log-b-0001': 'recorded_after_cutoff', 'log-z-0001': 'removed_after_cutoff',
    'case::舊式匯出': 'unidentified', 'item:item-key-0001:子案初稿（改）': 'unidentified', 'item:item-key-0002:子案進度': 'as_of_cutoff' });
  assert.equal(g.undatedLogCount, 1); assert(g.limitations.includes('undated_logs'));
  assert.equal(g.progress.some(e => e.date === '2026-10-30'), false);
  assert.deepEqual(g.deliveries.period.records, [], 'item status 已完成 is not a delivery'); assert.equal(g.deliveries.status, 'none_recorded');
});

await test('collaboration, proxy recording, hotels and staff filter: department totals once, recordedBy is not a participant, C names and order', () => {
  const sub = { id: 'sub-1', caseId: 'X', submittedById: 1, submittedByName: '王一', createdAt: '2026-10-22T01:00:00', archivePath: '/x', recordIds: ['D1', 'D2', 'D3'], summary: {}, zeroSupport: [],
    itemsSnapshot: [], legacyCounts: {}, decision: 'approved', decidedAt: '2026-10-23T01:00:00', decidedById: 9, decidedByName: '主管九', decisionReason: null, zeroSupportApproved: true };
  const parts = { staff, hotels, cases: [kase('X', { deliveryMode: 'records', hotel: '新竹館' }), kase('Y', { hotel: null }), kase('Z', { hotel: '不存在館', designerId: 2 })],
    _collaborators: [{ caseId: 'X', staffId: 1 }, { caseId: 'X', staffId: 2 }, { caseId: 'X', staffId: 3 }],
    case_deliveries: [dlv('D1', 'X', 'main', 2, '2026-10-20', { recordedById: 9, recordedByName: '主管九' }), dlv('D2', 'X', 'extension', 3, '2026-10-21', { recordedById: 2, recordedByName: '陳二' }),
      dlv('D3', 'X', 'support', 0, '2026-10-22', { note: '僅提供既有檔案' })], case_delivery_submissions: [sub] };
  const kParts = { ...parts, staff: staff.map(s => s.id === 2 ? { ...s, name: '陳二改名' } : s), hotels: hotels.map(h => ({ ...h, sortOrder: 100 - h.sortOrder })),
    cases: parts.cases.map(c => c.id === 'X' ? { ...c, designerId: 4 } : c) };
  const p = build(state(parts), state(parts));
  const x = row(p, 'X');
  assert.deepEqual(x.assignment, { designer: { id: 1, name: '王一', nameStatus: 'known' }, collaborators: [{ id: 2, name: '陳二', nameStatus: 'known' }, { id: 3, name: '林三', nameStatus: 'known' }] });
  assert.deepEqual(p.summary.deliveries.period.map(g => [g.kind, g.knownSubtotal]), [['main', 2], ['extension', 3], ['support', 0]]);
  assert.deepEqual(x.deliveries.period.records.find(d => d.id === 'D3').zeroSupport, { status: 'approved', submissionId: 'sub-1', decidedAt: '2026-10-23T01:00:00.000000Z', decidedByName: '主管九', note: '僅提供既有檔案' });
  assert.deepEqual(p.hotelOrder.map(h => h.key), ['hotel:1', 'hotel:2', 'hotel:3', 'unmatched:不存在館', 'none'], 'sortOrder then id; inactive and empty hotels kept');
  assert.deepEqual(p.rows.map(r => r.id), ['X', 'Z', 'Y']);
  assert.deepEqual([row(p, 'Y').hotel.match, row(p, 'Z').hotel.match], ['none', 'unmatched']);
  // unapproved support 0 is never shown as approved
  const pending = build(state({ ...parts, case_delivery_submissions: [{ ...sub, decision: null, decidedAt: null, zeroSupportApproved: null }] }), state({ ...parts, case_delivery_submissions: [{ ...sub, decision: null }] }));
  assert.equal(row(pending, 'X').deliveries.period.records.find(d => d.id === 'D3').zeroSupport.status, 'pending');
  // revision with K renames / reorder / reassignment: C names and order stay
  const v2 = build(state(parts), state(kParts), { K, revision: 2, supersedesId: 'wr_v1', revisionReason: '館序調整後重產' });
  assert.deepEqual(v2.hotelOrder.slice(0, 3).map(h => h.key), ['hotel:1', 'hotel:2', 'hotel:3']); assert.equal(v2.staff.find(s => s.id === 2).name, '陳二');
  assert.equal(row(v2, 'X').assignment.designer.id, 1);
  // filters come from the stored payload only and re-summarise with the same function
  const stored = plain(p), hash = P.payloadSha256(stored);
  const s2 = P.filterPayload(stored, { staffId: 2 });
  assert.deepEqual(s2.rows.map(r => r.id), ['X', 'Z']); assert.equal(s2.filter.staffBasis, 'participating_cases_at_cutoff');
  assert.deepEqual(s2.summary.deliveries.period.map(g => [g.kind, g.knownSubtotal]), [['main', 2], ['extension', 3], ['support', 0]]);
  assert.deepEqual(P.filterPayload(stored, { staffId: 9 }).rows, [], 'recording on behalf is not participation');
  assert.deepEqual(P.filterPayload(stored, { staffId: 4 }).rows, [], 'K reassignment is not the C participant');
  assert.deepEqual(P.filterPayload(stored, { hotel: 'none' }).rows.map(r => r.id), ['Y']);
  assert.deepEqual(P.filterPayload(stored, { hotel: 'hotel:3', staffId: 3 }).rows.map(r => r.id), ['X']);
  assert.equal(P.payloadSha256(stored), hash, 'filtering never mutates the stored payload');
  assert.equal(P.filterPayload(stored, { hotel: 'hotel:2' }).summary.caseCount.knownSubtotal, 0);
});

await test('cases deleted during the period make the population incomplete; deleted after C keeps the C row with a limitation', () => {
  const parts = { staff, hotels, cases: [kase('A1', { deliveryMode: 'records' }), kase('A2', { deliveryMode: 'records' })] };
  const p = build(state(parts), state({ ...parts, cases: [parts.cases[0]] }), { K, revision: 2, supersedesId: 'wr_v1', revisionReason: '刪案後重產', deletedCaseIds: ['A2', 'GONE'] });
  assert.deepEqual(p.sourceCompleteness.deletedCaseIds, ['GONE']); assert(p.sourceCompleteness.reasons.includes('cases_deleted_during_period'));
  assert.deepEqual(p.summary.caseCount, { knownSubtotal: 2, total: null });
  assert(row(p, 'A2').limitations.includes('case_deleted_after_cutoff'));
});

await test('legacy date proxy: future start is not in progress; missing start is unknown; schedule keeps official and adoption-observed dates apart', () => {
  const parts = { staff, hotels, cases: [kase('F1', { dispatchDate: '2026-10-26', openDate: '2026-10-26' }), kase('U1', { dispatchDate: null, openDate: null }),
    kase('M1', { scheduleMode: 'managed', scheduleBaseline: { dispatchDate: '2026-10-02', copyDate: null, printDate: null, goLiveDate: '2026-11-20', observedAt: '2026-10-05T01:00:00.000Z', source: 'observed_at_adoption' } })],
    change_logs: [{ id: 7, caseId: 'M1', field: 'goLiveDate', fromValue: '2026-11-20', toValue: '2026-11-30', reason: '需求方延後', operator: '主管九', createdAt: '2026-10-21T02:00:00' },
      { id: 8, caseId: 'M1', field: 'goLiveDate', fromValue: '2026-11-30', toValue: '2026-12-05', reason: '期後', operator: '主管九', createdAt: '2026-10-26T02:00:00' }] };
  const p = build(state(parts), state(parts));
  assert.equal(row(p, 'F1'), undefined); assert.deepEqual(p.unresolved.map(u => [u.id, u.activity.basis]), [['U1', 'legacy_missing_start_date']]);
  const m = row(p, 'M1');
  assert.deepEqual(m.schedule.official.goLiveDate, '2026-11-30'); assert.equal(m.schedule.observedAtAdoption.label, 'observed_at_adoption');
  assert.deepEqual(m.scheduleChanges.map(c => [c.id, c.reason, c.at]), [[7, '需求方延後', '2026-10-21T02:00:00.000000Z']]);
});

await test('early review ①: the counting mode is anchored at C; legacy unknown and old totals survive a records adoption seen only at K', () => {
  const cParts = { staff, hotels, cases: [kase('X', { outputCount: 7, requestCount: 3 }), kase('W', { deliveryMode: 'records', outputCount: 4 })], case_deliveries: [dlv('w1', 'W', 'main', 1, '2026-10-20')] };
  const kRecords = { ...cParts, cases: [kase('X', { outputCount: 7, requestCount: 3, deliveryMode: 'records' }), cParts.cases[1]] };
  const v2 = build(state(cParts), state(kRecords), { K, revision: 2, supersedesId: 'wr_v1', revisionReason: '導入後重產' });
  const x = row(v2, 'X').deliveries;
  assert.deepEqual([x.mode, x.modeBasis, x.knowledgeMode, x.status], ['legacy', 'cutoff', 'records', 'unknown']);
  assert.deepEqual(x.legacyCounts, { requestCount: 3, outputCount: 7, periodAttribution: 'unknown' });
  assert.equal(v2.summary.deliveries.status, 'partial'); assert.equal(v2.summary.deliveries.period[0].total, null);
  // backfilled K records on that case: partial known part, never complete
  const kBackfill = { ...kRecords, case_deliveries: [...kRecords.case_deliveries, dlv('x1', 'X', 'main', 2, '2026-10-21')] };
  const v3 = build(state(cParts), state(kBackfill), { K, revision: 2, supersedesId: 'wr_v1', revisionReason: '補登交付' });
  assert.deepEqual([row(v3, 'X').deliveries.status, v3.summary.deliveries.status], ['partial', 'partial']);
  assert.deepEqual(v3.summary.deliveries.period.map(g => [g.kind, g.knownSubtotal, g.total]), [['main', 3, null]]);
  // a records case at C with an old total: shown apart, not added
  const w = row(v3, 'W').deliveries;
  assert.deepEqual([w.mode, w.status, w.legacyCounts], ['records', 'known', { requestCount: null, outputCount: 4, periodAttribution: 'unknown' }]);
  assert.deepEqual(totals(w.period.totals), { 'main/件': 1 }); assert.deepEqual(totals(w.cumulativeToEnd.totals), { 'main/件': 1 });
});

await test('early review ②: stored log dates are validated on the real calendar; impossible dates are undated, never period work', () => {
  const feb = periodFromStart('month', '2026-02-01'), f = periodInstants(feb);
  const mk = logs => ({ staff, hotels, cases: [kase('OLD', { status: 'closed', closedOn: '2026-01-31', dispatchDate: '2026-01-02', logs })] });
  const run = parts => P.buildWorkReportPayload({ period: feb, cutoff: f.cutoffInstant, knowledgeCutoff: f.cutoffInstant, observedAt: f.cutoffInstant,
    coverageStart: '2026-01-01T00:00:00.000000Z', revision: 1, trigger: 'manual', endState: state(parts), knowledge: state(parts) });
  for (const bad of ['2026-02-30', '2026-02-29', '2026-2-10', '2026-02-10T09:00']) {
    const p = run(mk([{ date: bad, note: '舊資料' }]));
    assert.deepEqual(p.rows, [], bad + ' must not bring the case in'); assert.equal(p.summary.caseCount.knownSubtotal, 0);
  }
  const ok = run(mk([{ date: '2026-02-28', note: '月底' }, { date: '2026-03-01', note: '下月' }, { date: '2026-02-30', note: '不存在' }]));
  assert.deepEqual(row(ok, 'OLD').progress.map(e => e.date), ['2026-02-28']); assert.equal(row(ok, 'OLD').undatedLogCount, 1);
  const leap = periodFromStart('month', '2028-02-01'), l = periodInstants(leap);
  const lp = P.buildWorkReportPayload({ period: leap, cutoff: l.cutoffInstant, knowledgeCutoff: l.cutoffInstant, observedAt: l.cutoffInstant, coverageStart: '2026-01-01T00:00:00.000000Z',
    revision: 1, trigger: 'manual', endState: state(mk([{ date: '2028-02-29', note: '閏日' }])), knowledge: state(mk([{ date: '2028-02-29', note: '閏日' }])) });
  assert.deepEqual(row(lp, 'OLD').progress.map(e => e.date), ['2028-02-29']);
});

await test('fingerprints bind action, operator, period, parent and intent; serialize/meta and SQLSTATE translation', () => {
  const p2 = periodFromStart('week', '2026-10-26');
  assert.equal(generateFingerprint(9, week), generateFingerprint(9, week)); assert.notEqual(generateFingerprint(9, week), generateFingerprint(8, week));
  assert.notEqual(generateFingerprint(9, week), generateFingerprint(9, p2));
  const parent = { id: 'wr_x', periodKind: 'week', startDate: '2026-10-19', rulesVersion: P.RULES_VERSION };
  const base = revisionFingerprint(9, parent, { expectedLatestRevision: 1, reason: '補登' });
  assert.notEqual(base, revisionFingerprint(9, parent, { expectedLatestRevision: 2, reason: '補登' }));
  assert.notEqual(base, revisionFingerprint(9, parent, { expectedLatestRevision: 1, reason: '更正' }));
  assert.notEqual(base, revisionFingerprint(8, parent, { expectedLatestRevision: 1, reason: '補登' }));
  assert.notEqual(base, revisionFingerprint(9, { ...parent, id: 'wr_y' }, { expectedLatestRevision: 1, reason: '補登' }));
  assert.notEqual(base, generateFingerprint(9, week), 'a generate key never matches a revision');
  assert.equal(pgCode({ code: 'P2010', meta: { code: '23505' } }), '23505'); assert.equal(pgCode({ code: 'P2034' }), '40001');
  assert.equal(pgCode({ message: 'could not serialize access due to concurrent update' }), '40001'); assert.equal(pgCode({ code: 'P2025' }), null);
  const meta = serializeMeta({ id: 'wr_x', periodKind: 'week', startDate: '2026-10-19', endDateExclusive: '2026-10-26', cutoffInstant: C, knowledgeCutoff: C, observedAt: C,
    generatedAt: C, coverageStart: null, rulesVersion: P.RULES_VERSION, revision: 1, supersedesId: null, revisionReason: null, generatedById: 9, generatedByName: '主管九', trigger: 'manual',
    payloadSha256: 'a'.repeat(64), sourceCompleteness: 'insufficient', endStateMaxEventId: null, knowledgeMaxEventId: null, idempotencyKey: 'secret-key-1', requestFingerprint: 'b'.repeat(64) });
  assert.equal(meta.label, '2026-W43'); assert.equal('idempotencyKey' in meta, false); assert.equal('requestFingerprint' in meta, false);
});

await test('early service review ②: a full reset between revise\'s target read and latest read is an explicit 404 with no write', async () => {
  const { createWorkReportService } = await import(root + '/src/lib/workReports.js');
  const target = { id: 'wr_00000000-0000-4000-8000-000000000001', periodKind: 'week', startDate: '2026-10-19', endDateExclusive: '2026-10-26', cutoffInstant: C, knowledgeCutoff: C,
    observedAt: C, generatedAt: C, coverageStart: null, rulesVersion: P.RULES_VERSION, revision: 1, supersedesId: null, revisionReason: null, generatedById: 9, generatedByName: '主管九',
    trigger: 'manual', payloadSha256: 'a'.repeat(64), sourceCompleteness: 'insufficient', endStateMaxEventId: null, knowledgeMaxEventId: null, idempotencyKey: 'gen-key-0001', requestFingerprint: 'b'.repeat(64) };
  const calls = [];
  const fakeDb = { async $queryRawUnsafe(sql, ...params) {
    calls.push(sql.replace(/\s+/g, ' ').slice(0, 60));
    if (/FROM "staff"/.test(sql)) return [{ id: 9, name: '主管九', role: 'admin', active: true, pendingActivation: false, sessionVersion: 0 }];
    if (/WHERE "id" = \$1/.test(sql)) return [target];                       // target read before the reset
    if (/"idempotencyKey" = \$1/.test(sql)) return [];
    if (/ORDER BY "revision" DESC/.test(sql)) return [];                      // reset purged every version
    throw Error('unexpected query: ' + sql);
  }, $transaction() { throw Error('must not open a publication transaction'); }, $executeRawUnsafe() { throw Error('must not write'); } };
  const svc = createWorkReportService({ db: fakeDb, readSources: () => { throw Error('must not read sources'); } });
  await assert.rejects(svc.revise({ id: 9 }, { sessionVersion: 0 }, target.id, { reason: '補登交付', expectedLatestRevision: 1, idempotencyKey: 'rev-key-0001' }),
    e => e.status === 404 && e.code === 'not_found');
  assert(!calls.some(c => /INSERT/.test(c)));
});

await test('E3a periods: additive read-only coverage metadata (real DB clock + report_source_coverage id 1); existing fields unchanged; no coverage row = null; never writes', async () => {
  const { createWorkReportService } = await import(root + '/src/lib/workReports.js');
  for (const coverageStart of ['2026-10-28T06:19:40.766679Z', null]) {
    const sqls = [];
    const fakeDb = { async $queryRawUnsafe(sql, ...params) {
      sqls.push(sql);
      if (/clock_timestamp\(\)/.test(sql)) return [{ now: '2026-10-28T07:00:00.000001Z', coverageStart }];
      if (/FROM "report_snapshots"/.test(sql)) return [];
      throw Error('unexpected query: ' + sql);
    }, $transaction() { throw Error('must not open a transaction'); }, $executeRawUnsafe() { throw Error('must not write'); } };
    const svc = createWorkReportService({ db: fakeDb, readSources: () => { throw Error('must not read sources'); } });
    const r = await svc.periods('week', '2026-10-12', '2026-10-26');
    assert.deepEqual(Object.keys(r), ['kind', 'rulesVersion', 'coverage', 'periods'], 'one additive top-level field');
    assert.deepEqual(r.coverage, { coverageStart, observedAt: '2026-10-28T07:00:00.000001Z' });
    assert.deepEqual(r.periods.map(p => [p.startDate, p.startInstant, p.cutoffInstant, p.ended, p.versions.length]),
      [['2026-10-12', '2026-10-11T16:00:00.000000Z', '2026-10-18T16:00:00.000000Z', true, 0], ['2026-10-19', '2026-10-18T16:00:00.000000Z', '2026-10-25T16:00:00.000000Z', true, 0],
        ['2026-10-26', '2026-10-25T16:00:00.000000Z', '2026-11-01T16:00:00.000000Z', false, 0]], 'period fields and ended keep their meaning');
    assert.equal(sqls.length, 2, 'no extra query: coverage rides on the clock read');
    assert(/FROM "report_source_coverage" WHERE "id" = 1/.test(sqls[0]) && sqls.every(s => /^\s*SELECT/i.test(s) && !/INSERT|UPDATE|DELETE|nextval|pg_advisory/i.test(s)), 'SELECT only');
  }
});

console.log(JSON.stringify({ workReportPureTests: passed }));
