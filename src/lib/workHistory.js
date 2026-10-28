// REPORTS-P4-E4: read-only "work history review (from the data retained today)" — separate from the formal period-end
// snapshots. It never feeds current tables to buildWorkReportPayload as a fake end state, never writes (no snapshot,
// version, coverage, event or case change) and has no migration, schedule or mail.
//
// What a row can say (HISTORY-PROVABILITY-SAFE-MAP):
// - evidence: a valid in-period date on a case/item log, a non-voided delivery, a status ChangeLog recorded in the
//   period, a recorded work cycle overlapping it, or a current done/closed case whose closedOn lies in it;
// - inferred: only the case's dispatch→recorded-end dates intersect the period ("日期區間推估", never proof of work);
//   after lifecycle adoption only cycles count (a sealed gap is not "in progress");
// - unresolved: the dates cannot decide (e.g. terminal without an end date) — listed apart, never 0, never hidden.
// Hotel, owner/collaborators, title and status are CURRENT values. Everything is "what is recorded now": later backfill
// or correction changes the result and deleted data cannot be restored. Counts are known subtotals; a total exists only
// when every listed case kept delivery records for the whole period and nothing is unresolved. Closure evidence (cycle
// completed / status changed to done·closed / current closedOn) is counted once per case and is NOT a completion total.
import { prisma } from './db.js';
import { periodFromStart, periodInstants, taipeiDateOf, parseDateOnly } from './reportPeriods.js';
import { WorkReportError } from './workReports.js';

// Bounded read for this new read-only entry (explicit 422 above any budget, never a silent cut): a SQL pre-check of the
// candidate count and their raw logs/items JSON bytes runs BEFORE any JSON is loaded, and the built response is capped.
export const MAX_HISTORY_CASES = 5000;
export const MAX_SOURCE_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const tooLarge = () => new WorkReportError(422, 'history_too_large', '這個期間相關的資料量超過單次回顧的上限，請改看較短的期間（週或月）。');
export const MAX_ENTRIES_PER_CASE = 200;
export const MAX_NOTE_CHARS = 500;
const ISO_US = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const ts = col => `to_char(${col} AT TIME ZONE 'UTC', '${ISO_US}')`;
const day = col => `to_char(${col}, 'YYYY-MM-DD')`;
const KIND_ORDER = ['main', 'extension', 'support'];
const CLOSED = new Set(['done', 'closed']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v, max) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) + '…' : v) : null);
const cut = (v, max) => typeof v === 'string' && v.length > max;   // explicit flag next to every shortened text
function dateOnly(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  try { parseDateOnly(v); return v; } catch { return null; }
}
const inPeriod = (d, p) => d != null && d >= p.startDate && d < p.endDateExclusive;

// ── read: one RepeatableRead READ ONLY transaction, parameterised, no N+1 ─────────────────────────────────────────
export async function readWorkHistorySources(db, period, { timeout = 60000 } = {}) {
  const { startInstant: S, cutoffInstant: C } = periodInstants(period);
  const s = period.startDate, e = period.endDateExclusive;
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const [clock] = await tx.$queryRawUnsafe(`SELECT ${ts('clock_timestamp()')} AS "observedAt"`);
    if (clock.observedAt < S) throw new WorkReportError(422, 'period_not_started', '期間尚未開始，沒有可回顧的資料。');
    const hotels = await tx.$queryRawUnsafe(`SELECT "id", "name", "sortOrder", "active" FROM "hotels" ORDER BY "sortOrder", "id"`);
    // Candidate SUPERSET (every inclusion decision is made in JS): dates that may intersect, any in-period record, or any
    // non-empty case/item log container — stored log dates are free text, so SQL never pre-judges them.
    const candidates = `FROM "cases" c
      WHERE ((c."dispatchDate" < $2::date OR c."openDate" < $2::date)
             AND NOT (c."status" IN ('done', 'closed') AND c."closedOn" IS NOT NULL AND c."closedOn" < $1::date)
             AND NOT (c."status" = 'cancelled' AND c."cancelledOn" IS NOT NULL AND c."cancelledOn" < $1::date))
         OR EXISTS (SELECT 1 FROM "case_deliveries" d WHERE d."caseId" = c."id" AND d."deliveredOn" >= $1::date AND d."deliveredOn" < $2::date)
         OR EXISTS (SELECT 1 FROM "case_cycles" y WHERE y."caseId" = c."id" AND y."startedAt" < $4::timestamptz AND (y."endedAt" IS NULL OR y."endedAt" > $3::timestamptz))
         OR EXISTS (SELECT 1 FROM "change_logs" l WHERE l."caseId" = c."id" AND l."field" = 'status' AND l."createdAt" >= $3::timestamptz AND l."createdAt" < $4::timestamptz)
         OR (c."logs" IS NOT NULL AND c."logs" NOT IN ('null'::jsonb, '[]'::jsonb, '{}'::jsonb))
         OR (c."items" IS NOT NULL AND c."items" NOT IN ('null'::jsonb, '[]'::jsonb, '{}'::jsonb))`;
    const [budget] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS "cases",
        COALESCE(sum(COALESCE(octet_length(c."logs"::text), 0) + COALESCE(octet_length(c."items"::text), 0)), 0)::bigint::text AS "jsonBytes" ${candidates}`, s, e, S, C);
    if (budget.cases > MAX_HISTORY_CASES || Number(budget.jsonBytes) > MAX_SOURCE_JSON_BYTES) throw tooLarge();
    const cases = await tx.$queryRawUnsafe(`SELECT c."id", c."title", c."hotel", c."status", c."archived", ${day('c."openDate"')} AS "openDate",
        ${day('c."dispatchDate"')} AS "dispatchDate", ${day('c."closedOn"')} AS "closedOn", ${day('c."cancelledOn"')} AS "cancelledOn", c."designerId",
        c."deliveryMode", ${ts('c."deliveryModeSince"')} AS "deliveryModeSince", c."lifecycleMode", c."lifecycleStatus", c."requestCount", c."outputCount", c."items", c."logs"
      ${candidates}
      ORDER BY c."id" LIMIT ${MAX_HISTORY_CASES + 1}`, s, e, S, C);
    if (cases.length > MAX_HISTORY_CASES) throw tooLarge();   // rows inserted between the two reads cannot appear (same RR snapshot); kept as a guard
    const ids = cases.map(c => c.id);
    if (!ids.length) return { observedAt: clock.observedAt, hotels, staff: [], cases, collaborators: [], deliveries: [], cycles: [], statusChanges: [], submissions: [] };
    const collaborators = await tx.$queryRawUnsafe(`SELECT "A" AS "caseId", "B" AS "staffId" FROM "_collaborators" WHERE "A" = ANY($1::text[])`, ids);
    const staffIds = [...new Set([...cases.map(c => c.designerId), ...collaborators.map(x => x.staffId)].filter(Number.isInteger))];
    const staff = await tx.$queryRawUnsafe(`SELECT "id", "name", "active" FROM "staff" WHERE "id" = ANY($1::int[])`, staffIds);
    const deliveries = await tx.$queryRawUnsafe(`SELECT "id", "caseId", "itemKey", "itemName", "kind", "quantity", "unit", ${day('"deliveredOn"')} AS "deliveredOn",
        ${ts('"createdAt"')} AS "createdAt", ${ts('"voidedAt"')} AS "voidedAt", "voidReason", "cycleId", "note"
      FROM "case_deliveries" WHERE "caseId" = ANY($1::text[]) AND "deliveredOn" >= $2::date AND "deliveredOn" < $3::date ORDER BY "deliveredOn", "id"`, ids, s, e);
    const cycles = await tx.$queryRawUnsafe(`SELECT "id", "caseId", "sequence", "source", ${ts('"startedAt"')} AS "startedAt", ${ts('"endedAt"')} AS "endedAt", "outcome"
      FROM "case_cycles" WHERE "caseId" = ANY($1::text[]) ORDER BY "caseId", "sequence"`, ids);
    const statusChanges = await tx.$queryRawUnsafe(`SELECT "id", "caseId", "fromValue", "toValue", ${ts('"createdAt"')} AS "createdAt"
      FROM "change_logs" WHERE "caseId" = ANY($1::text[]) AND "field" = 'status' AND "createdAt" >= $2::timestamptz AND "createdAt" < $3::timestamptz
      ORDER BY "createdAt", "id"`, ids, S, C);
    const zeroCases = [...new Set(deliveries.filter(d => d.kind === 'support' && d.quantity === 0).map(d => d.caseId))];
    const submissions = zeroCases.length ? await tx.$queryRawUnsafe(`SELECT "id", "caseId", "recordIds", "decision", ${ts('"decidedAt"')} AS "decidedAt",
        "decidedByName", "zeroSupportApproved" FROM "case_delivery_submissions" WHERE "caseId" = ANY($1::text[])`, zeroCases) : [];
    return { observedAt: clock.observedAt, hotels, staff, cases, collaborators, deliveries, cycles, statusChanges, submissions };
  }, { isolationLevel: 'RepeatableRead', timeout });
}

// ── pure pieces ─────────────────────────────────────────────────────────────────────────────────────────────────
export function groupTotals(records) {
  const m = new Map();
  for (const r of records) {
    const k = r.kind + '\u0000' + r.unit, g = m.get(k) || { kind: r.kind, unit: r.unit, quantity: 0, records: 0 };
    g.quantity += r.quantity; g.records += 1; m.set(k, g);
  }
  const rank = k => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
  return [...m.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || byStr(a.kind, b.kind) || byStr(a.unit, b.unit));
}

// Case logs and items[].logs only (no recursive date scraping). Dedup by a stable non-empty id within its own scope
// (case / item key / keyless item position); entries without an id are kept and flagged (cannot be deduplicated).
export function collectLogs(row, p, today) {
  const scopes = [{ source: 'case', scope: 'case', itemKey: null, itemName: null, logs: row.logs }];
  (Array.isArray(row.items) ? row.items : []).forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return;
    const key = typeof it.key === 'string' && it.key ? it.key : null;
    scopes.push({ source: 'item', scope: key ? 'item:' + key : 'item#' + i, itemKey: key, itemName: text(it.n, 200), logs: it.logs });
  });
  const seen = new Set(), entries = [];
  let undated = 0, withoutId = 0, duplicates = 0, future = 0;
  for (const sc of scopes) {
    for (const l of Array.isArray(sc.logs) ? sc.logs : []) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) { undated++; continue; }
      const date = dateOnly(l.date);
      if (!date) { undated++; continue; }
      if (!inPeriod(date, p)) continue;
      if (date > today) { future++; continue; }   // a future-dated entry is a plan, not recorded work
      const id = typeof l.id === 'string' && l.id ? l.id : null;
      if (id) { const k = sc.scope + '|' + id; if (seen.has(k)) { duplicates++; continue; } seen.add(k); } else withoutId++;
      const note = typeof l.note === 'string' ? l.note : l.text;
      entries.push({ source: sc.source, itemKey: sc.itemKey, itemName: sc.itemName, id, date,
        note: text(note, MAX_NOTE_CHARS), noteTruncated: cut(note, MAX_NOTE_CHARS), by: text(typeof l.by === 'string' ? l.by : l.author, 100) });
    }
  }
  entries.sort((a, b) => byStr(a.date, b.date) || byStr(a.source, b.source) || byStr(a.itemKey ?? '', b.itemKey ?? '') || byStr(a.id ?? '', b.id ?? ''));
  // Preview cap only: `total` is every in-period entry and every count/summary/CSV figure uses it; `truncated` says so.
  // `lastDate` comes from ALL entries, so the latest activity and its sorting never depend on the preview cap.
  return { entries: entries.slice(0, MAX_ENTRIES_PER_CASE), truncated: entries.length > MAX_ENTRIES_PER_CASE, total: entries.length,
    lastDate: entries.length ? entries[entries.length - 1].date : null, undated, withoutId, duplicates, future };
}

function zeroSupport(record, submissions) {
  if (!(record.kind === 'support' && record.quantity === 0)) return null;
  const has = s => Array.isArray(s.recordIds) && s.recordIds.includes(record.id);
  const approved = submissions.filter(s => s.decision === 'approved' && has(s)).sort((a, b) => byStr(String(a.decidedAt), String(b.decidedAt))).at(-1);
  if (approved) return { status: approved.zeroSupportApproved === true ? 'approved' : 'not_approved', decidedAt: approved.decidedAt ?? null,
    decidedByName: text(approved.decidedByName, 100), note: text(record.note, MAX_NOTE_CHARS) };
  const pending = submissions.find(s => s.decision == null && has(s));
  return { status: pending ? 'pending' : 'not_submitted', decidedAt: null, decidedByName: null, note: text(record.note, MAX_NOTE_CHARS) };
}

function hotelKeyer(hotels) {
  const byName = new Map(hotels.map(h => [h.name, h]));
  return raw => {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) return { groupKey: 'none', raw: null, match: 'none' };
    const h = byName.get(v);
    return h ? { groupKey: 'hotel:' + h.id, raw: v, match: 'matched' } : { groupKey: 'unmatched:' + v, raw: v, match: 'unmatched' };
  };
}

// Date-range inference when no positive record exists: [dispatchDate (or openDate), recorded end] ∩ [S, E).
function inferFromDates(c, cycles, p) {
  const start = dateOnly(c.dispatchDate) || dateOnly(c.openDate);
  if (!start) return { kind: 'unresolved', reason: 'start_date_missing' };
  if (start >= p.endDateExclusive) return null;   // started at/after the period end: not this period
  if (c.lifecycleMode === 'managed' && cycles.length) {
    // Only the pre-adoption legacy part is inferable; after adoption only recorded cycles count (gaps are not work).
    const adoption = taipeiDateOf(cycles[0].startedAt);
    return adoption > p.startDate ? { kind: 'inferred', basis: 'dates_before_lifecycle_adoption', from: start, to: adoption } : null;
  }
  let end = null;
  if (CLOSED.has(c.status)) { end = dateOnly(c.closedOn); if (!end) return { kind: 'unresolved', reason: 'closed_without_end_date' }; }
  else if (c.status === 'cancelled') { end = dateOnly(c.cancelledOn); if (!end) return { kind: 'unresolved', reason: 'cancelled_without_end_date' }; }
  else if (c.archived) return { kind: 'unresolved', reason: 'archived_without_end_date' };
  if (end && end < start) return { kind: 'unresolved', reason: 'end_before_start' };
  if (end && end < p.startDate) return null;
  return { kind: 'inferred', basis: c.status === 'cancelled' ? 'dates_until_cancelled' : end ? 'dates_until_closed' : 'dates_open_ended', from: start, to: end };
}

export function buildWorkHistory({ period, observedAt, hotels = [], staff = [], cases = [], collaborators = [], deliveries = [], cycles = [], statusChanges = [], submissions = [] }) {
  const p = periodFromStart(period.kind, period.startDate);
  const { startInstant: S, cutoffInstant: C } = periodInstants(p);
  const today = taipeiDateOf(observedAt);
  const inProgress = observedAt < C;
  const staffById = new Map(staff.map(s => [s.id, s]));
  const person = id => { const s = staffById.get(id); return { id, name: s ? text(s.name, 100) : null, active: s ? s.active !== false : null }; };
  const collabOf = new Map(); for (const x of collaborators) (collabOf.get(x.caseId) || collabOf.set(x.caseId, []).get(x.caseId)).push(x.staffId);
  const group = (list, key) => { const m = new Map(); for (const x of list) (m.get(x[key]) || m.set(x[key], []).get(x[key])).push(x); return m; };
  const dByCase = group(deliveries, 'caseId'), yByCase = group(cycles, 'caseId'), lByCase = group(statusChanges, 'caseId'), sByCase = group(submissions, 'caseId');
  const keyOf = hotelKeyer(hotels);
  const rows = [], unresolved = [];
  for (const c of cases) {
    const hotel = keyOf(c.hotel);
    const current = { status: c.status, archived: !!c.archived, lifecycleStatus: c.lifecycleStatus ?? null, deliveryMode: c.deliveryMode,
      designer: person(c.designerId), collaborators: [...new Set(collabOf.get(c.id) || [])].map(person).sort((a, b) => byStr(a.name ?? '', b.name ?? '') || a.id - b.id),
      dates: { openDate: c.openDate ?? null, dispatchDate: c.dispatchDate ?? null, closedOn: c.closedOn ?? null, cancelledOn: c.cancelledOn ?? null } };
    const base = { id: c.id, title: text(c.title, 300), hotel, current };
    const evidence = new Set(), limitations = new Set(), closure = [];
    // logs
    const logs = collectLogs(c, p, today);
    for (const e of logs.entries) evidence.add(e.source === 'case' ? 'case_log' : 'item_log');
    if (logs.undated) limitations.add('undated_logs'); if (logs.withoutId) limitations.add('logs_without_id'); if (logs.truncated) limitations.add('progress_truncated');
    if (logs.future) limitations.add('future_dated_logs');
    // deliveries (unique id; voided listed, never summed)
    // A business date after the observation day has not happened yet (in-progress periods): never counted as occurred.
    const seenD = new Set(), active = [], voided = [];
    let futureDeliveries = 0;
    for (const d of dByCase.get(c.id) || []) {
      if (seenD.has(d.id) || !inPeriod(dateOnly(d.deliveredOn), p)) continue; seenD.add(d.id);
      if (d.deliveredOn > today) { futureDeliveries++; continue; }
      const r = { id: d.id, kind: d.kind, quantity: d.quantity, unit: d.unit, itemName: text(d.itemName, 200), deliveredOn: d.deliveredOn };
      if (d.voidedAt) { voided.push({ ...r, voidReason: text(d.voidReason, MAX_NOTE_CHARS) }); continue; }
      active.push({ ...r, recordedAfterPeriod: d.createdAt >= C, cycleAttribution: d.cycleId ? 'recorded' : 'unknown', zeroSupport: zeroSupport(d, sByCase.get(c.id) || []) });
    }
    if (active.length) evidence.add('delivery');
    if (futureDeliveries) limitations.add('future_dated_deliveries');
    if (active.some(r => r.recordedAfterPeriod)) limitations.add('delivery_recorded_after_period');
    if (active.some(r => r.cycleAttribution === 'unknown')) limitations.add('delivery_cycle_attribution_unknown');
    const covered = c.deliveryMode === 'records' && typeof c.deliveryModeSince === 'string' && c.deliveryModeSince <= S;
    if (!covered) limitations.add(c.deliveryMode === 'records' ? 'records_adopted_during_or_after_period' : 'legacy_delivery_mode');
    const legacyCounts = c.requestCount != null || c.outputCount != null ? { requestCount: c.requestCount ?? null, outputCount: c.outputCount ?? null } : null;
    if (legacyCounts) limitations.add('legacy_counts_period_unknown');
    // status changes recorded in the period (best effort: a missing log does not mean no change)
    const changes = (lByCase.get(c.id) || []).filter(x => x.createdAt >= S && x.createdAt < C)
      .map(x => ({ from: text(x.fromValue, 40), to: text(x.toValue, 40), at: x.createdAt, date: taipeiDateOf(x.createdAt) }));
    if (changes.length) evidence.add('status_change');
    for (const x of changes) if (CLOSED.has(x.to)) closure.push({ basis: 'status_change', date: x.date });
    // recorded cycles overlapping the period
    const caseCycles = (yByCase.get(c.id) || []).slice().sort((a, b) => a.sequence - b.sequence);
    const overlap = caseCycles.filter(y => y.startedAt < C && (y.endedAt == null || y.endedAt > S))
      .map(y => ({ sequence: y.sequence, source: y.source, startedAt: y.startedAt, endedAt: y.endedAt ?? null, outcome: y.outcome ?? null }));
    if (overlap.length) evidence.add('cycle_overlap');
    // completion is taken from ALL cycles: a cycle completed exactly at S does not overlap [S, C) but its completion event is in it
    for (const y of caseCycles) if (y.outcome === 'completed' && y.endedAt && y.endedAt >= S && y.endedAt < C) {
      closure.push({ basis: 'cycle_completed', date: taipeiDateOf(y.endedAt) }); evidence.add('cycle_completed');
    }
    // current closedOn in the period (reopening clears closedOn; cancelled / sealed are never closure). archived only means
    // "put away": it neither makes a case complete nor removes a real closedOn. Past status_change / completed-cycle
    // records above stay even when the case is cancelled or sealed now — they read "有結案紀錄", never period-end completion.
    if (CLOSED.has(c.status) && inPeriod(dateOnly(c.closedOn), p)) {
      if (c.closedOn <= today) { evidence.add('closed_on'); closure.push({ basis: 'closed_on', date: c.closedOn }); }
      else limitations.add('closed_on_after_observation');   // recorded closing date not reached yet: not a closure event so far
    }

    let inclusion = 'evidence', inferred = null;
    if (!evidence.size) {
      inferred = inferFromDates(c, caseCycles, p);
      if (!inferred) continue;
      if (inferred.kind === 'unresolved') { unresolved.push({ ...base, reason: inferred.reason }); continue; }
      inclusion = 'inferred'; limitations.add('inferred_from_dates');
    }
    const status = active.length ? (covered ? 'recorded' : 'partial') : covered ? 'none_recorded' : 'unknown';
    const dates = [logs.lastDate, ...active.map(r => r.deliveredOn), ...changes.map(x => x.date), ...closure.map(x => x.date)].filter(Boolean).sort();
    rows.push({ ...base, inclusion, evidenceKinds: [...evidence].sort(), inferred: inferred ? { basis: inferred.basis, from: inferred.from, to: inferred.to ?? null } : null,
      progress: logs.entries, progressCount: logs.total, progressTruncated: logs.truncated, undatedLogCount: logs.undated, logsWithoutId: logs.withoutId, duplicateLogIds: logs.duplicates,
      deliveries: { status, records: active, voided, totals: groupTotals(active) }, legacyCounts, statusChanges: changes, cycles: overlap,
      closure: [...new Map(closure.map(x => [x.basis + '|' + x.date, x])).values()].sort((a, b) => byStr(a.date, b.date) || byStr(a.basis, b.basis)),
      lastActivityDate: dates.at(-1) || null, limitations: [...limitations].sort() });
  }
  // current hotel order: dictionary sortOrder, then unmatched raw names, then "none"
  const used = new Set([...rows, ...unresolved].map(r => r.hotel.groupKey));
  const hotelOrder = [...hotels].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id).map(h => ({ key: 'hotel:' + h.id, name: text(h.name, 200), active: h.active !== false }));
  for (const k of [...used].filter(k => k.startsWith('unmatched:')).sort()) hotelOrder.push({ key: k, name: k.slice(10), active: null, unmatched: true });
  if (used.has('none')) hotelOrder.push({ key: 'none', name: null, active: null });
  const rank = new Map(hotelOrder.map((h, i) => [h.key, i]));
  const order = (a, b) => (rank.get(a.hotel.groupKey) ?? 1e9) - (rank.get(b.hotel.groupKey) ?? 1e9) || byStr(a.id, b.id);
  rows.sort(order); unresolved.sort(order);
  const people = new Map();
  for (const r of [...rows, ...unresolved]) for (const s of [r.current.designer, ...r.current.collaborators]) if (s && !people.has(s.id)) people.set(s.id, s);
  const staffList = [...people.values()].sort((a, b) => byStr(a.name ?? '', b.name ?? '') || a.id - b.id);
  return { mode: 'retrospective', basis: 'current_retained_data', period: { ...p, startInstant: S, cutoffInstant: C }, observedAt, inProgress,
    notices: ['current_values_not_period_end', 'later_edits_change_result', 'deleted_data_not_restorable', 'not_a_formal_report'],
    hotelOrder, staff: staffList, rows, unresolved, summary: summarizeHistory(rows, unresolved) };
}

// Same algorithm runs in public/work-reports.js for filtered views (tests compare both).
export function summarizeHistory(rows, unresolved) {
  const seen = new Set(), records = [];
  for (const r of rows) for (const d of r.deliveries.records) if (!seen.has(d.id)) { seen.add(d.id); records.push(d); }
  const complete = !unresolved.length && rows.every(r => r.deliveries.status === 'recorded' || r.deliveries.status === 'none_recorded');
  const closed = rows.filter(r => r.closure.length);
  const basisCount = b => closed.filter(r => r.closure.some(x => x.basis === b)).length;
  const statusCounts = {}; for (const r of rows) statusCounts[r.current.status] = (statusCounts[r.current.status] || 0) + 1;
  return {
    cases: { evidence: rows.filter(r => r.inclusion === 'evidence').length, inferred: rows.filter(r => r.inclusion === 'inferred').length, unresolved: unresolved.length },
    closure: { caseCount: closed.length, cycleCompleted: basisCount('cycle_completed'), statusChange: basisCount('status_change'), closedOn: basisCount('closed_on') },
    deliveries: { status: complete ? 'complete' : 'partial', groups: groupTotals(records).map(g => ({ ...g, knownSubtotal: g.quantity, total: complete ? g.quantity : null })) },
    progress: { entries: rows.reduce((n, r) => n + r.progressCount, 0), cases: rows.filter(r => r.progressCount > 0).length },
    currentStatus: statusCounts,
  };
}

export function filterHistory(payload, { hotel, staffId } = {}) {
  const keep = r => (!hotel || r.hotel.groupKey === hotel) && (staffId == null || r.current.designer?.id === staffId || r.current.collaborators.some(s => s.id === staffId));
  const rows = payload.rows.filter(keep), unresolved = payload.unresolved.filter(keep);
  return { ...payload, filter: { hotel: hotel || null, staffId: staffId ?? null }, rows, unresolved, summary: summarizeHistory(rows, unresolved) };
}

export function createWorkHistoryService({ db = prisma, readSources = readWorkHistorySources } = {}) {
  return {
    async read(kind, startDate) {
      const p = periodFromStart(kind, startDate);
      const src = await readSources(db, p);
      const payload = buildWorkHistory({ period: p, ...src });
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESPONSE_BYTES) throw tooLarge();
      return payload;
    },
  };
}
export const workHistory = createWorkHistoryService();
