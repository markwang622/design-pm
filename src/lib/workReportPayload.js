// REPORTS-P3-E1b: work-report payload (pure; no DB, no clock). Built from two reconstructions of the report sources
// (reportSources.reconstructAt) taken in ONE repeatable-read snapshot:
// - endState  = read(C), C = Taipei 00:00 of the period's endDateExclusive. It decides the end-of-period status,
//   primary/collaborators, schedule (official / observed at adoption), hotel name + order and staff names.
// - knowledge = read(K), K ≥ C (initial version K = C; a revision fixes K from the DB clock). It decides the deliveries,
//   progress and void corrections known at K. A revision never lets K's resume / reassignment / rename replace C.
// Unknown is never 0: totals that cannot be proven are null (knownSubtotal is reported separately); empty rows of an
// insufficient snapshot mean "cannot be reconstructed", never "no work". Nothing here reads live tables.
// Rules are versioned (RULES_VERSION); a change of any rule below is a new rules version, not a silent rewrite.
import crypto from 'node:crypto';
import { normalizeInstant, taipeiMidnightInstant, parseDateOnly } from './reportPeriods.js';

export const RULES_VERSION = 'work-report.v1';
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const KIND_ORDER = ['main', 'extension', 'support'];
const OPEN_STATUSES = new Set(['todo', 'wait', 'doing', 'review', 'review_done', 'print']);
const DONE_STATUSES = new Set(['done', 'closed']);
const STAFF_FILTER_BASIS = 'participating_cases_at_cutoff';

// ── canonical JSON + hash: object keys sorted at every level (all kept, null kept), array order as given ──────────
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('non-finite number in payload'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => {
      if (value[k] === undefined) throw new TypeError('undefined value in payload at key ' + k);
      return JSON.stringify(k) + ':' + canonicalJson(value[k]);
    }).join(',') + '}';
  }
  throw new TypeError('unsupported value in payload: ' + typeof value);
}
export const payloadSha256 = payload => crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');

// ── source value helpers (projection JSON: dates 'YYYY-MM-DD'; Prisma timestamp(3) columns are UTC without a zone) ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day 'YYYY-MM-DD' (no rollover: 2026-02-30 is not a date) or null = unknown. Stored log dates are free text.
function dateOnly(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  try { parseDateOnly(v); return v; } catch { return null; }
}
// Date-only half-open membership on calendar strings; never throws on odd stored dates.
const inPeriod = (d, p) => d != null && d >= p.startDate && d < p.endDateExclusive;
function instantOf(v) {
  if (typeof v !== 'string' || !v) return null;
  try { return normalizeInstant(/(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : v + 'Z'); } catch { return null; }
}
const str = v => (v == null ? null : String(v));
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sameJson = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const values = m => Object.values(m || {});

function assignmentFrom(tables, caseRow) {
  if (!caseRow) return null;
  const collab = new Set();
  for (const r of values(tables._collaborators)) if (r.caseId === caseRow.id && r.staffId !== caseRow.designerId) collab.add(r.staffId);
  const person = id => { const s = tables.staff?.[String(id)]; return { id, name: s ? s.name : null, nameStatus: s ? 'known' : 'unknown' }; };
  return { designer: caseRow.designerId == null ? null : person(caseRow.designerId), collaborators: [...collab].sort((a, b) => a - b).map(person) };
}

// End-of-period state at C (never from K).
function endStateOf(c) {
  const managed = c.lifecycleMode === 'managed';
  let kind;
  if (c.status === 'cancelled' || c.lifecycleStatus === 'cancelled') kind = 'cancelled';
  else if (managed ? c.lifecycleStatus === 'completed' : DONE_STATUSES.has(c.status)) kind = 'completed';
  else if (c.lifecycleStatus === 'sealed_incomplete') kind = 'sealed_incomplete';
  else if (c.archived) kind = 'archived_not_completed';
  else kind = 'open';
  return { kind, status: c.status ?? null, archived: !!c.archived, lifecycleMode: c.lifecycleMode ?? 'legacy', lifecycleStatus: c.lifecycleStatus ?? null,
    closedOn: dateOnly(c.closedOn), cancelledOn: dateOnly(c.cancelledOn), cancelReason: c.cancelReason ?? null,
    pending: { delivery: !!c.pendingDeliverySubmissionId || c.status === 'review_done', schedule: !!c.pendingScheduleRequestId, lifecycle: !!c.pendingLifecycleRequestId } };
}
// Next step: a fixed table on the C state (rules version work-report.v1). K's later state never drives it.
const STATUS_STEP = { todo: ['start_work', '待開始製作'], wait: ['await_materials', '等待資料／素材'], doing: ['in_production', '製作中'],
  review: ['in_review', '提案／審稿中'], print: ['in_print', '送印中'] };
function nextStepOf(end) {
  if (!end) return { code: 'not_recorded_at_cutoff', label: '期末尚無此案紀錄', basis: 'knowledge_cutoff' };
  const step = (code, label) => ({ code, label, basis: 'end_state' });
  if (end.kind === 'completed') return step('none_completed', '已完成');
  if (end.kind === 'cancelled') return step('none_cancelled', '已取消');
  if (end.kind === 'sealed_incomplete') return step(end.pending.lifecycle ? 'await_lifecycle_decision' : 'may_request_resume',
    end.pending.lifecycle ? '待主管決議復工' : '未完成封存（非完成）：可由設計師申請、主管核准後原單復工');
  if (end.kind === 'archived_not_completed') return step('archived_status_unknown', '已收起（非完成）：後續狀態未記錄');
  if (end.pending.lifecycle) return step('await_lifecycle_decision', '待主管決議封存申請');
  if (end.pending.schedule) return step('await_schedule_decision', '待主管決議改期');
  if (end.pending.delivery) return step('await_delivery_approval', '待主管核可交付');
  const s = STATUS_STEP[end.status];
  return s ? step(s[0], s[1]) : step('unknown_status', '狀態未對應');
}

// In progress during [S, C): managed → CaseCycle [startedAt, endedAt) intersects [S, C) (half-open both ways; a sealed
// gap is not in progress); legacy → existing date proxy with explicit basis, unknown when a date is missing.
function activityOf(c, cycles, p, S, C) {
  if (c.lifecycleMode === 'managed') {
    const own = cycles.filter(y => y.caseId === c.id);
    if (!own.length) return { state: 'unknown', basis: 'managed_without_cycle' };
    let first = null, any = false;
    for (const y of own) {
      const start = instantOf(y.startedAt), end = instantOf(y.endedAt);
      if (!start) return { state: 'unknown', basis: 'cycle_time_unknown' };
      if (!first || start < first) first = start;
      if (start < C && (end == null || end > S)) any = true;
    }
    if (any) return { state: 'yes', basis: 'managed_cycles' };
    return first > S ? { state: 'unknown', basis: 'before_lifecycle_adoption' } : { state: 'no', basis: 'managed_cycles' };
  }
  const start = dateOnly(c.dispatchDate) || dateOnly(c.openDate);
  if (!start) return { state: 'unknown', basis: 'legacy_missing_start_date' };
  if (start >= p.endDateExclusive) return { state: 'no', basis: 'legacy_date_proxy' };
  let end = null;
  if (c.status === 'cancelled') { end = dateOnly(c.cancelledOn); if (!end) return { state: 'unknown', basis: 'legacy_missing_end_date' }; }
  else if (DONE_STATUSES.has(c.status)) { end = dateOnly(c.closedOn); if (!end) return { state: 'unknown', basis: 'legacy_missing_end_date' }; }
  else if (c.archived) return { state: 'unknown', basis: 'legacy_archived_without_end_date' };
  if (end != null && end < p.startDate) return { state: 'no', basis: 'legacy_date_proxy' };
  return { state: 'yes', basis: 'legacy_date_proxy' };
}
// Completion event inside the period (not the stock of completed cases). Seal / cancel / archive are never completion.
function completionOf(c, cycles, p, S, C) {
  if (c.lifecycleMode === 'managed') {
    const done = cycles.find(y => y.caseId === c.id && y.outcome === 'completed');
    if (!done) return { state: 'no', at: null, basis: 'cycle_outcome' };
    const at = instantOf(done.endedAt);
    if (!at) return { state: 'unknown', at: null, basis: 'cycle_outcome' };
    return { state: at >= S && at < C ? 'yes' : 'no', at, basis: 'cycle_outcome' };
  }
  if (!DONE_STATUSES.has(c.status)) return { state: 'no', at: null, basis: 'legacy_status' };
  const on = dateOnly(c.closedOn);
  if (!on) return { state: 'unknown', at: null, basis: 'legacy_missing_closed_on' };
  return { state: on >= p.startDate && on < p.endDateExclusive ? 'yes' : 'no', at: on, basis: 'legacy_closed_on' };
}

function hotelOf(raw, hotelsByName) {
  const v = raw == null || String(raw).trim() === '' ? null : String(raw);
  if (v == null) return { raw: raw ?? null, match: 'none', hotelId: null, groupKey: 'none' };
  const h = hotelsByName.get(v);
  return h ? { raw: v, match: 'matched', hotelId: h.id, groupKey: 'hotel:' + h.id } : { raw: v, match: 'unmatched', hotelId: null, groupKey: 'unmatched:' + v };
}

// Logs (case level and item level) visible at K whose date lies in [S, E). C/K comparison by stable id only; entries
// without an id are "unidentified" unless the whole container is unchanged between C and K. Original fields are kept.
function logsOf(row) {
  const out = [];
  const caseLogs = Array.isArray(row?.logs) ? row.logs : [];
  for (const l of caseLogs) out.push({ source: 'case', itemKey: null, itemName: null, log: l });
  for (const it of Array.isArray(row?.items) ? row.items : []) {
    if (!it || typeof it !== 'object') continue;
    for (const l of Array.isArray(it.logs) ? it.logs : []) out.push({ source: 'item', itemKey: it.key ?? null, itemName: it.n ?? null, log: l });
  }
  return out;
}
function itemLogsByKey(row) {
  const m = new Map();
  for (const it of Array.isArray(row?.items) ? row.items : []) if (it && typeof it === 'object' && it.key) m.set(it.key, it.logs ?? null);
  return m;
}
function progressOf(cRow, kRow, p, sameCut) {
  const base = kRow ?? cRow; if (!base) return { entries: [], undated: 0 };
  const cById = new Map(); for (const e of logsOf(cRow)) if (e.log && typeof e.log === 'object' && typeof e.log.id === 'string') cById.set(e.source + '|' + (e.itemKey ?? '') + '|' + e.log.id, e.log);
  const caseLogsSame = sameJson(cRow?.logs, base.logs), cItems = itemLogsByKey(cRow), kItems = itemLogsByKey(base);
  const entries = [], seen = new Set(); let undated = 0;
  for (const e of logsOf(base)) {
    const l = e.log && typeof e.log === 'object' && !Array.isArray(e.log) ? e.log : { value: e.log };
    const date = dateOnly(l.date);
    if (!date) { undated++; continue; }
    if (!inPeriod(date, p)) continue;
    let knowledge;
    if (sameCut || !kRow) knowledge = 'as_of_cutoff';
    else if (!cRow) knowledge = 'recorded_after_cutoff';
    else if (typeof l.id === 'string') {
      const key = e.source + '|' + (e.itemKey ?? '') + '|' + l.id; seen.add(key);
      const prior = cById.get(key);
      knowledge = !prior ? 'recorded_after_cutoff' : sameJson(prior, l) ? 'as_of_cutoff' : 'corrected_after_cutoff';
    } else {
      const same = e.source === 'case' ? caseLogsSame : (e.itemKey != null && cItems.has(e.itemKey) && sameJson(cItems.get(e.itemKey), kItems.get(e.itemKey)));
      knowledge = same ? 'as_of_cutoff' : 'unidentified';
    }
    entries.push({ source: e.source, itemKey: e.itemKey, itemName: e.itemName, id: typeof l.id === 'string' ? l.id : null, date,
      note: typeof l.note === 'string' ? l.note : typeof l.text === 'string' ? l.text : null,
      by: typeof l.by === 'string' ? l.by : typeof l.author === 'string' ? l.author : null, entry: l, knowledge });
  }
  // Identified entries present at C (dated in the period) but gone at K: shown, never silently dropped.
  if (!sameCut && kRow && cRow) {
    for (const e of logsOf(cRow)) {
      const l = e.log; if (!l || typeof l !== 'object' || typeof l.id !== 'string') continue;
      const key = e.source + '|' + (e.itemKey ?? '') + '|' + l.id; const date = dateOnly(l.date);
      if (seen.has(key) || !date || !inPeriod(date, p)) continue;
      if (logsOf(kRow).some(x => x.log && x.log.id === l.id && x.source === e.source && (x.itemKey ?? '') === (e.itemKey ?? ''))) continue;
      entries.push({ source: e.source, itemKey: e.itemKey, itemName: e.itemName, id: l.id, date, note: typeof l.note === 'string' ? l.note : typeof l.text === 'string' ? l.text : null,
        by: typeof l.by === 'string' ? l.by : typeof l.author === 'string' ? l.author : null, entry: l, knowledge: 'removed_after_cutoff' });
    }
  }
  entries.sort((a, b) => byId(a.date, b.date) || byId(a.source, b.source) || byId(a.itemKey ?? '', b.itemKey ?? '') || byId(a.id ?? '', b.id ?? ''));
  return { entries, undated };
}

function groupTotals(records) {
  const m = new Map();
  for (const r of records) {
    const k = r.kind + '\u0000' + r.unit, g = m.get(k) || { kind: r.kind, unit: r.unit, quantity: 0, records: 0 };
    g.quantity += r.quantity; g.records += 1; m.set(k, g);
  }
  const rank = k => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
  return [...m.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || byId(a.kind, b.kind) || byId(a.unit, b.unit));
}
function zeroSupportEvidence(record, submissions) {
  if (!(record.kind === 'support' && record.quantity === 0)) return null;
  const has = s => Array.isArray(s.recordIds) && s.recordIds.includes(record.id);
  const approved = submissions.filter(s => s.decision === 'approved' && has(s)).sort((a, b) => byId(String(a.decidedAt), String(b.decidedAt))).at(-1);
  if (approved) return { status: approved.zeroSupportApproved === true ? 'approved' : 'not_approved', submissionId: approved.id,
    decidedAt: instantOf(approved.decidedAt), decidedByName: approved.decidedByName ?? null, note: record.note ?? null };
  const pending = submissions.find(s => s.decision == null && has(s));
  return { status: pending ? 'pending' : 'not_submitted', submissionId: pending ? pending.id : null, decidedAt: null, decidedByName: null, note: record.note ?? null };
}

// Deliveries: K-visible, not voided at K, unique by record id. Period = deliveredOn ∈ [S, E); cumulative = deliveredOn < E
// (never the following periods). kind × unit never summed across. Legacy counts kept apart, with unknown period attribution.
function deliveriesOf(caseId, cRow, kRow, endTables, knowTables, p, sameCut) {
  const all = values(knowTables.case_deliveries).filter(d => d.caseId === caseId);
  const cRecords = endTables.case_deliveries || {};
  const submissions = values(knowTables.case_delivery_submissions).filter(s => s.caseId === caseId);
  const active = all.filter(d => d.voidedAt == null);
  const seenIds = new Set(), period = [], cumulative = [];
  for (const d of active.sort((a, b) => byId(a.id, b.id))) {
    if (seenIds.has(d.id)) continue; seenIds.add(d.id);
    const on = dateOnly(d.deliveredOn); if (!on) continue;
    if (on < p.endDateExclusive) cumulative.push(d);
    if (inPeriod(on, p)) period.push(d);
  }
  const atC = id => cRecords[id] && cRecords[id].voidedAt == null;
  const shown = d => ({ id: d.id, itemKey: d.itemKey ?? null, itemName: d.itemName ?? null, kind: d.kind, quantity: d.quantity, unit: d.unit, deliveredOn: dateOnly(d.deliveredOn),
    note: d.note ?? null, recordedById: d.recordedById ?? null, recordedByName: d.recordedByName ?? null, cycleId: d.cycleId ?? null,
    cycleAttribution: d.cycleId ? 'cycle' : 'unknown', knowledge: sameCut || atC(d.id) ? 'as_of_cutoff' : 'recorded_after_cutoff',
    zeroSupport: zeroSupportEvidence(d, submissions) });
  const voidedAfterCutoff = sameCut ? [] : all.filter(d => d.voidedAt != null && atC(d.id) && inPeriod(dateOnly(d.deliveredOn), p))
    .sort((a, b) => byId(a.id, b.id)).map(d => ({ id: d.id, kind: d.kind, quantity: d.quantity, unit: d.unit, deliveredOn: dateOnly(d.deliveredOn),
      voidedAt: instantOf(d.voidedAt), voidReason: d.voidReason ?? null, knowledge: 'voided_after_cutoff' }));
  // The counting mode is anchored at C for a case that exists at C: adopting records after C (seen only at K) never turns
  // the period's legacy unknown into "none recorded" / complete. Knowledge-only cases use their labelled K mode.
  const anchor = cRow ?? kRow, mode = anchor?.deliveryMode === 'records' ? 'records' : 'legacy';
  let status;
  if (mode === 'records') status = period.length ? 'known' : 'none_recorded';
  else status = period.length ? 'partial' : 'unknown';
  // Old per-case totals are always shown on their own (whatever the mode); never added to period or ledger sums.
  const legacyCounts = anchor && (mode === 'legacy' || anchor.requestCount != null || anchor.outputCount != null)
    ? { requestCount: anchor.requestCount ?? null, outputCount: anchor.outputCount ?? null, periodAttribution: 'unknown' } : null;
  return { mode, modeBasis: cRow ? 'cutoff' : 'knowledge_cutoff', knowledgeMode: kRow?.deliveryMode ?? null, status,
    period: { records: period.map(shown), totals: groupTotals(period) }, cumulativeToEnd: { totals: groupTotals(cumulative) }, voidedAfterCutoff, legacyCounts };
}

function scheduleChangesOf(caseId, endTables, knowTables, S, C, sameCut) {
  return values(knowTables.change_logs).filter(l => l.caseId === caseId).map(l => ({ l, at: instantOf(l.createdAt) }))
    .filter(x => x.at && x.at >= S && x.at < C).sort((a, b) => byId(a.at, b.at) || a.l.id - b.l.id)
    .map(({ l, at }) => ({ id: l.id, field: l.field, fromValue: l.fromValue ?? null, toValue: l.toValue ?? null, reason: l.reason ?? null, operator: l.operator ?? null, at,
      knowledge: sameCut || endTables.change_logs?.[String(l.id)] ? 'as_of_cutoff' : 'recorded_after_cutoff' }));
}

function scheduleOf(c) {
  const b = c.scheduleBaseline && typeof c.scheduleBaseline === 'object' ? c.scheduleBaseline : null;
  return { mode: c.scheduleMode ?? 'legacy', official: { dispatchDate: dateOnly(c.dispatchDate), copyDate: dateOnly(c.copyDate), printDate: dateOnly(c.printDate), goLiveDate: dateOnly(c.goLiveDate) },
    observedAtAdoption: b ? { dispatchDate: b.dispatchDate ?? null, copyDate: b.copyDate ?? null, printDate: b.printDate ?? null, goLiveDate: b.goLiveDate ?? null,
      observedAt: b.observedAt ?? null, label: 'observed_at_adoption' } : null };
}

// ── summary: the same pure function for the stored payload and any filtered view ──────────────────────────────────
export function summarize({ rows, unresolved, sourceCompleteness }) {
  const status = sourceCompleteness.status;
  if (status === 'insufficient') {
    const nil = { knownSubtotal: null, total: null };
    return { caseCount: nil, activeCaseCount: nil, completedInPeriod: nil, deliveries: { period: [], status: 'unknown' }, deliveryStatusCounts: null, unresolvedCaseCount: null };
  }
  const complete = status === 'complete' && !(sourceCompleteness.deletedCaseIds || []).length;
  const totalIf = (ok, n) => ({ knownSubtotal: n, total: ok ? n : null });
  const counts = { known: 0, none_recorded: 0, unknown: 0, partial: 0 };
  for (const r of rows) counts[r.deliveries.status] = (counts[r.deliveries.status] || 0) + 1;
  const unknownOutput = counts.unknown > 0 || counts.partial > 0 || unresolved.some(u => u.deliveryMode !== 'records');
  const seen = new Set(), records = [];
  for (const r of rows) for (const d of r.deliveries.period.records) if (!seen.has(d.id)) { seen.add(d.id); records.push(d); }
  const completionUnknown = rows.some(r => r.completion?.state === 'unknown') || unresolved.length > 0;
  return {
    caseCount: totalIf(complete && !unresolved.length, rows.length),
    activeCaseCount: totalIf(complete && !unresolved.length && rows.every(r => r.activity.state !== 'unknown'), rows.filter(r => r.activity.state === 'yes').length),
    completedInPeriod: totalIf(complete && !completionUnknown, rows.filter(r => r.completion?.state === 'yes').length),
    deliveries: { period: groupTotals(records).map(g => ({ ...g, knownSubtotal: g.quantity, total: complete && !unknownOutput ? g.quantity : null })),
      status: complete && !unknownOutput ? 'complete' : 'partial' },
    deliveryStatusCounts: counts,
    unresolvedCaseCount: unresolved.length,
  };
}

// ── build ─────────────────────────────────────────────────────────────────────────────────────────────────────
// input: { period, cutoff, knowledgeCutoff, observedAt, coverageStart, revision, supersedesId, revisionReason, generatedBy,
//          trigger, endState: reconstructAt(C) result, knowledge: reconstructAt(K) result, deletedCaseIds: case ids with a
//          D event whose transaction was recorded in [S, C) }
export function buildWorkReportPayload(input) {
  const { period: p, cutoff: C, knowledgeCutoff: K, endState, knowledge } = input;
  const S = taipeiMidnightInstant(p.startDate);
  if (C !== taipeiMidnightInstant(p.endDateExclusive)) throw new Error('cutoff must be the Taipei midnight of endDateExclusive');
  if (K < C) throw new Error('knowledge cutoff precedes the period cutoff');
  const coverageStart = input.coverageStart ?? endState?.coverageStart ?? null;
  const meta = { periodKind: p.kind, startDate: p.startDate, endDateExclusive: p.endDateExclusive, label: p.label, startInstant: S, cutoffInstant: C,
    knowledgeCutoff: K, observedAt: input.observedAt, rulesVersion: RULES_VERSION, revision: input.revision, supersedesId: input.supersedesId ?? null,
    revisionReason: input.revisionReason ?? null, trigger: input.trigger, generatedBy: input.generatedBy ?? null, coverageStart,
    sources: { endState: 'cutoff', knowledge: K === C ? 'cutoff' : 'knowledge_cutoff', endStateMaxEventId: endState?.maxEventId ?? null, knowledgeMaxEventId: knowledge?.maxEventId ?? null },
    staffFilterBasis: STAFF_FILTER_BASIS };
  if (!endState || endState.status !== 'ok') {
    const sourceCompleteness = { status: 'insufficient', coverageStart, endStateCovered: false, periodCovered: false, knowledgeCovered: coverageStart != null && coverageStart <= K,
      reasons: ['end_state_before_coverage'], deletedCaseIds: [] };
    const payload = { meta, sourceCompleteness, hotelOrder: [], staff: [], rows: [], unresolved: [] };
    payload.summary = summarize({ rows: [], unresolved: [], sourceCompleteness });
    return payload;
  }
  if (!knowledge || knowledge.status !== 'ok') throw new Error('knowledge state must be covered when the end state is');
  const sameCut = K === C;
  const E = endState.tables, Kt = knowledge.tables;
  const periodCovered = coverageStart != null && coverageStart <= S;
  const deletedCaseIds = [...new Set(input.deletedCaseIds || [])].filter(id => !E.cases?.[id]).sort(byId);
  const reasons = [];
  if (!periodCovered) reasons.push('period_start_before_coverage');
  if (deletedCaseIds.length) reasons.push('cases_deleted_during_period');
  const sourceCompleteness = { status: periodCovered ? 'complete' : 'partial', coverageStart, endStateCovered: true, periodCovered, knowledgeCovered: true, reasons, deletedCaseIds };

  const hotels = values(E.hotels).slice().sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
  const hotelsByName = new Map(hotels.map(h => [h.name, h]));
  const cyclesC = values(E.case_cycles);
  const rows = [], unresolved = [];
  const ids = [...new Set([...Object.keys(E.cases || {}), ...Object.keys(Kt.cases || {})])].sort(byId);
  for (const id of ids) {
    const c = E.cases?.[id] ?? null, k = Kt.cases?.[id] ?? null;
    const deliveries = deliveriesOf(id, c, k, E, Kt, p, sameCut);
    const progress = progressOf(c, k, p, sameCut);
    const evidence = deliveries.period.records.length > 0 || progress.entries.some(e => e.knowledge !== 'removed_after_cutoff');
    if (c) {
      const activity = activityOf(c, cyclesC, p, S, C), completion = completionOf(c, cyclesC, p, S, C);
      const assignment = assignmentFrom(E, c), hotel = hotelOf(c.hotel, hotelsByName);
      if (activity.state !== 'yes' && completion.state !== 'yes' && !evidence) {
        if (activity.state === 'unknown') unresolved.push({ id, title: c.title ?? null, hotel, assignment, deliveryMode: c.deliveryMode ?? 'legacy', activity, completion });
        continue;
      }
      const end = endStateOf(c), limitations = [];
      if (!k) limitations.push('case_deleted_after_cutoff');
      if (activity.state === 'unknown') limitations.push(activity.basis);
      if (progress.undated) limitations.push('undated_logs');
      if (deliveries.status === 'unknown' || deliveries.status === 'partial') limitations.push('legacy_output_period_unknown');
      if (deliveries.period.records.some(d => d.cycleAttribution === 'unknown') && c.lifecycleMode === 'managed') limitations.push('delivery_cycle_attribution_unknown');
      rows.push({ id, identityBasis: 'cutoff', title: c.title ?? null, subTitle: c.subTitle ?? null, level: c.level ?? null, hotel, assignment,
        schedule: scheduleOf(c), scheduleChanges: scheduleChangesOf(id, E, Kt, S, C, sameCut), endState: end, nextStep: nextStepOf(end),
        activity, completion, progress: progress.entries, undatedLogCount: progress.undated, deliveries, limitations });
    } else if (k && evidence) {
      // Recorded only after C (backfill): identity from K, labelled; no invented C assignment, status or hotel order.
      const raw = hotelOf(k.hotel, hotelsByName);
      rows.push({ id, identityBasis: 'knowledge_cutoff', title: k.title ?? null, subTitle: k.subTitle ?? null, level: k.level ?? null,
        hotel: { ...raw, match: 'not_recorded_at_cutoff', hotelId: null, groupKey: 'not_recorded_at_cutoff' },
        assignment: { ...assignmentFrom(Kt, k), basis: 'knowledge_cutoff' }, schedule: null, scheduleChanges: scheduleChangesOf(id, E, Kt, S, C, sameCut),
        endState: { kind: 'not_recorded_at_cutoff' }, nextStep: nextStepOf(null), activity: { state: 'unknown', basis: 'not_recorded_at_cutoff' },
        completion: { state: 'unknown', at: null, basis: 'not_recorded_at_cutoff' }, progress: progress.entries, undatedLogCount: progress.undated, deliveries,
        limitations: ['recorded_after_cutoff'] });
    }
  }
  // Hotel order: dictionary at C by (sortOrder, id) incl. inactive and empty hotels; then unmatched names (stable code-unit
  // order), then no hotel, then rows not recorded at C.
  const hotelOrder = hotels.map(h => ({ key: 'hotel:' + h.id, hotelId: h.id, name: h.name, region: h.region ?? null, active: h.active !== false, sortOrder: h.sortOrder }));
  const unmatched = [...new Set([...rows, ...unresolved].filter(r => r.hotel.match === 'unmatched').map(r => r.hotel.raw))].sort(byId);
  for (const raw of unmatched) hotelOrder.push({ key: 'unmatched:' + raw, hotelId: null, name: raw, region: null, active: null, sortOrder: null });
  hotelOrder.push({ key: 'none', hotelId: null, name: null, region: null, active: null, sortOrder: null });
  if (rows.some(r => r.hotel.groupKey === 'not_recorded_at_cutoff')) hotelOrder.push({ key: 'not_recorded_at_cutoff', hotelId: null, name: null, region: null, active: null, sortOrder: null });
  const rank = new Map(hotelOrder.map((h, i) => [h.key, i]));
  const order = (a, b) => (rank.get(a.hotel.groupKey) - rank.get(b.hotel.groupKey)) || byId(a.id, b.id);
  rows.sort(order); unresolved.sort(order);
  // Staff referenced by the payload, named as of C (K for knowledge-only rows); display fields only.
  const staffIds = new Set();
  for (const r of [...rows, ...unresolved]) { if (r.assignment?.designer) staffIds.add(r.assignment.designer.id); for (const s of r.assignment?.collaborators || []) staffIds.add(s.id); }
  const staff = [...staffIds].sort((a, b) => a - b).map(id => {
    const s = E.staff?.[String(id)], ks = Kt.staff?.[String(id)];
    return s ? { id, name: s.name, active: s.active !== false, departedOn: dateOnly(s.departedOn), asOf: 'cutoff' }
      : { id, name: ks ? ks.name : null, active: ks ? ks.active !== false : null, departedOn: ks ? dateOnly(ks.departedOn) : null, asOf: ks ? 'knowledge_cutoff' : 'unknown' };
  });
  const payload = { meta, sourceCompleteness, hotelOrder, staff, rows, unresolved };
  payload.summary = summarize({ rows, unresolved, sourceCompleteness });
  return payload;
}

// ── filtered view: only from a stored payload (never re-reads Case or produces a snapshot) ────────────────────────
// staffId: the cases this person participated in at C (primary or collaborator; knowledge-only rows use their labelled K
// assignment). It is not an allocation of individual output and changes no KPI.
export function filterPayload(payload, { hotel, staffId } = {}) {
  const match = r => (hotel == null || r.hotel.groupKey === hotel)
    && (staffId == null || r.assignment?.designer?.id === staffId || (r.assignment?.collaborators || []).some(s => s.id === staffId));
  const rows = payload.rows.filter(match), unresolved = payload.unresolved.filter(match);
  const ids = new Set(); for (const r of [...rows, ...unresolved]) { if (r.assignment?.designer) ids.add(r.assignment.designer.id); for (const s of r.assignment?.collaborators || []) ids.add(s.id); }
  const view = { ...payload, staff: payload.staff.filter(s => ids.has(s.id)), rows, unresolved,
    filter: { hotel: hotel ?? null, staffId: staffId ?? null, staffBasis: STAFF_FILTER_BASIS } };
  view.summary = summarize({ rows, unresolved, sourceCompleteness: payload.sourceCompleteness });
  return view;
}
