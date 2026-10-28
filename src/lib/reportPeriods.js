// REPORTS-P3-E1a: work-report periods (pure; no DB, no clock reads unless a reference date is passed in).
// Separate from analytics.resolvePeriod on purpose: that helper carries Taipei calendar days as UTC-midnight Date
// objects, which must never be used as a timestamp cutoff.
//
// Two kinds of boundary, never mixed:
// - date-only: half-open [startDate, endDateExclusive) of 'YYYY-MM-DD' Asia/Taipei calendar strings. Date-only source
//   fields (deliveredOn, log dates, milestones, closedOn…) are compared as these strings.
// - instant: the real UTC instant of Taipei 00:00 on a boundary date (Taiwan has no DST: 00:00+08:00), rendered as an
//   ISO string with microsecond precision so SQL can compare it with timestamptz without JS millisecond truncation.
// Weeks start on Monday (natural Taipei week; the label uses the ISO week-year, so 2026-12-28 is "2026-W53").

export const PERIOD_KINDS = Object.freeze(['week', 'month', 'quarter']);
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;
export const MAX_PERIOD_RANGE = 60;
export const MAX_OFFSET_HOURS = 14;   // explicit-offset instants: ±00:00 … ±14:00, minutes 00–59
const TAIPEI_OFFSET_MINUTES = 8 * 60;

export class PeriodError extends Error {
  constructor(code, message) { super(message); this.name = 'PeriodError'; this.code = code; }
}
const invalid = (code, message) => { throw new PeriodError(code, message); };

// Strict 'YYYY-MM-DD' (real calendar day, year within range). Returns { y, m, d } (m 1-12).
export function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('invalid_date', '日期格式須為 YYYY-MM-DD');
  const [y, m, d] = value.split('-').map(Number);
  if (y < MIN_YEAR || y > MAX_YEAR) invalid('invalid_date', `年份須介於 ${MIN_YEAR}–${MAX_YEAR}`);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) invalid('invalid_date', '不存在的日期');
  return { y, m, d };
}
const pad = n => String(n).padStart(2, '0');
const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
// Calendar arithmetic on a pure date (UTC fields used only as a proleptic calendar, never as an instant).
function shiftDays(dateStr, days) {
  const { y, m, d } = parseDateOnly(dateStr);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function weekday(dateStr) { // 1 = Monday … 7 = Sunday
  const { y, m, d } = parseDateOnly(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}
function assertKind(kind) { if (!PERIOD_KINDS.includes(kind)) invalid('invalid_period_kind', '期間類型須為 week、month 或 quarter'); }

// ISO week-year and week number of a Monday-start week (the week belongs to the year of its Thursday).
function isoWeek(mondayStr) {
  const thursday = shiftDays(mondayStr, 3);
  const { y } = parseDateOnly(thursday);
  const jan4 = fmt(y, 1, 4);
  const week1Monday = shiftDays(jan4, 1 - weekday(jan4));
  const diff = (Date.parse(mondayStr + 'T00:00:00Z') - Date.parse(week1Monday + 'T00:00:00Z')) / 86400000;
  return { year: y, week: diff / 7 + 1 };
}

function build(kind, startDate, endDateExclusive) {
  let label;
  if (kind === 'week') { const w = isoWeek(startDate); label = `${w.year}-W${pad(w.week)}`; }
  else if (kind === 'month') label = startDate.slice(0, 7);
  else { const { y, m } = parseDateOnly(startDate); label = `${y}-Q${(m - 1) / 3 + 1}`; }
  return Object.freeze({ kind, startDate, endDateExclusive, label });
}
function endOf(kind, startDate) {
  if (kind === 'week') return shiftDays(startDate, 7);
  const { y, m } = parseDateOnly(startDate), add = kind === 'month' ? 1 : 3;
  const t = new Date(Date.UTC(y, m - 1 + add, 1));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
}

// The period that contains a Taipei calendar date.
export function periodContaining(kind, dateStr) {
  assertKind(kind); const { y, m } = parseDateOnly(dateStr);
  let start;
  if (kind === 'week') start = shiftDays(dateStr, 1 - weekday(dateStr));
  else if (kind === 'month') start = fmt(y, m, 1);
  else start = fmt(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  if (parseDateOnly(start).y < MIN_YEAR) invalid('invalid_date', `年份須介於 ${MIN_YEAR}–${MAX_YEAR}`);
  return build(kind, start, endOf(kind, start));
}

// A period identified by its start date; the start must be aligned (Monday / 1st / quarter's 1st).
export function periodFromStart(kind, startDate) {
  assertKind(kind); const p = periodContaining(kind, startDate);
  if (p.startDate !== startDate) invalid('unaligned_period_start', kind === 'week' ? '週報起日須為週一' : kind === 'month' ? '月報起日須為每月 1 日' : '季報起日須為 1、4、7、10 月 1 日');
  parseDateOnly(p.endDateExclusive);
  return p;
}
export const nextPeriod = p => periodFromStart(p.kind, p.endDateExclusive);
export const previousPeriod = p => periodContaining(p.kind, shiftDays(p.startDate, -1));

// Bounded list of consecutive periods [from … to] (by containing dates), at most MAX_PERIOD_RANGE.
export function listPeriods(kind, fromDate, toDate) {
  assertKind(kind);
  let p = periodContaining(kind, fromDate); const last = periodContaining(kind, toDate);
  if (p.startDate > last.startDate) invalid('invalid_range', '起始期間不可晚於結束期間');
  const out = [];
  for (;;) {
    out.push(p);
    if (p.startDate === last.startDate) return out;
    if (out.length >= MAX_PERIOD_RANGE) invalid('range_too_large', `一次最多 ${MAX_PERIOD_RANGE} 期`);
    p = nextPeriod(p);
  }
}

// Date-only membership: half-open, compared as calendar strings.
export function dateInPeriod(dateStr, p) { parseDateOnly(dateStr); return dateStr >= p.startDate && dateStr < p.endDateExclusive; }

// Real instant of Taipei 00:00 on a calendar date, as an ISO string with microseconds ('…T16:00:00.000000Z').
export function taipeiMidnightInstant(dateStr) {
  const { y, m, d } = parseDateOnly(dateStr);
  const t = new Date(Date.UTC(y, m - 1, d) - TAIPEI_OFFSET_MINUTES * 60000);
  return `${fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00.000000Z`;
}
// Timestamp bounds of a period: [startInstant, cutoffInstant) — cutoffInstant is Taipei 00:00 of endDateExclusive.
export function periodInstants(p) {
  return Object.freeze({ startInstant: taipeiMidnightInstant(p.startDate), cutoffInstant: taipeiMidnightInstant(p.endDateExclusive) });
}

// Taipei calendar date of an instant (ISO string or Date). Microsecond strings are accepted; sub-millisecond digits
// cannot move the calendar date, so the millisecond Date used here is exact for this purpose.
export function taipeiDateOf(instant) {
  const t = instant instanceof Date ? instant : new Date(String(instant));
  if (!Number.isFinite(t.getTime())) invalid('invalid_instant', '時間格式不正確');
  const local = new Date(t.getTime() + TAIPEI_OFFSET_MINUTES * 60000);
  return fmt(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
}

// Strict ISO instant with an explicit offset; returned normalised to UTC with microsecond precision (digits beyond
// microseconds are refused rather than rounded). Used for knowledge cutoffs handed back from the DB.
export function normalizeInstant(value) {
  if (typeof value !== 'string') invalid('invalid_instant', '時間格式不正確');
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!m) invalid('invalid_instant', '時間須為含時區的 ISO 格式（最多微秒）');
  const [, date, hh, mi, ss, frac = '', zone] = m; parseDateOnly(date);
  if (+hh > 23 || +mi > 59 || +ss > 59) invalid('invalid_instant', '時間超出範圍');
  const oh = zone === 'Z' ? 0 : Number(zone.slice(1, 3)), om = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (oh > MAX_OFFSET_HOURS || om > 59 || (oh === MAX_OFFSET_HOURS && om > 0)) invalid('invalid_instant', `時區偏移須介於 ±${MAX_OFFSET_HOURS}:00`);
  const offset = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
  const base = new Date(Date.parse(`${date}T${hh}:${mi}:${ss}Z`) - offset * 60000);
  if (!Number.isFinite(base.getTime()) || base.getUTCFullYear() < MIN_YEAR || base.getUTCFullYear() > MAX_YEAR) invalid('invalid_instant', `時間須介於 ${MIN_YEAR}–${MAX_YEAR} 年`);
  return `${fmt(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate())}T${pad(base.getUTCHours())}:${pad(base.getUTCMinutes())}:${pad(base.getUTCSeconds())}.${frac.padEnd(6, '0')}Z`;
}
