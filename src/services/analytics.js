// ─────────────────────────────────────────────────────────────
// Analytics service — period bucketing + contribution index.
//
// Contribution formula (v3.3, full-weight):
//   score(case, role) =
//        LEVEL_WEIGHT[level]
//      × ROLE_COEF[role]            // primary 1.0 / collaborator 0.4
//      × TIMELY_COEF(case)          // on-time ×1.1 / overdue ×0.8
//      × URGENT_COEF(case)          // urgent ×1.3 / normal ×1.0
//
// Counts cases where status ∈ { 'done', 'closed' } AND closedOn falls
// inside the requested natural calendar period. (v3.6 added 'closed'.)
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';

export const LEVEL_WEIGHT = { SS: 5, S: 4, A: 3, B: 2, C: 1, D: 1 };
export const ROLE_COEF = { primary: 1.0, collaborator: 0.4 };
// v3.7: timely → 三段（提早完成 / 準時 / 逾期）
export const TIMELY_COEF = { early: 1.2, onTime: 1.1, overdue: 0.8 };
export const URGENT_COEF = { urgent: 1.3, normal: 1.0 };
// "Early" threshold: closedOn ≤ goLiveDate − 1 day
const EARLY_THRESHOLD_DAYS = 1;

// ─── Period helpers (UTC, natural calendar) ───────────────
// week: ISO Mon–Sun
// month: 1st – last day
// half: H1 Jan-Jun, H2 Jul-Dec
// year: Jan 1 – Dec 31

function startOfWeekUTC(d) {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO: Monday=1 ... Sunday=7
  const dow = out.getUTCDay() === 0 ? 7 : out.getUTCDay();
  out.setUTCDate(out.getUTCDate() - (dow - 1));
  return out;
}
function addDaysUTC(d, n) {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
function addMonthsUTC(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function startOfMonthUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function startOfHalfUTC(d) {
  const m = d.getUTCMonth() < 6 ? 0 : 6;
  return new Date(Date.UTC(d.getUTCFullYear(), m, 1));
}
function startOfYearUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

/**
 * Resolve a [start, end) window for the requested period and offset.
 * offset=0 → current period; offset=-1 → previous period.
 * @param {'week'|'month'|'half'|'year'} period
 * @param {number} offset
 * @param {Date}   reference - "today" (defaults to now)
 */
export function resolvePeriod(period, offset = 0, reference = new Date()) {
  const ref = new Date(reference); // copy
  let start, end, label;

  if (period === 'week') {
    const cur = startOfWeekUTC(ref);
    start = addDaysUTC(cur, 7 * offset);
    end = addDaysUTC(start, 7);
    const yyyy = start.getUTCFullYear();
    const wkNum = isoWeekNumber(start);
    label = `${yyyy} W${String(wkNum).padStart(2, '0')}`;
  } else if (period === 'month') {
    const cur = startOfMonthUTC(ref);
    start = addMonthsUTC(cur, offset);
    end = addMonthsUTC(start, 1);
    label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  } else if (period === 'half') {
    const cur = startOfHalfUTC(ref);
    start = addMonthsUTC(cur, 6 * offset);
    end = addMonthsUTC(start, 6);
    const half = start.getUTCMonth() < 6 ? 'H1' : 'H2';
    label = `${start.getUTCFullYear()} ${half}`;
  } else if (period === 'year') {
    const cur = startOfYearUTC(ref);
    start = addMonthsUTC(cur, 12 * offset);
    end = addMonthsUTC(start, 12);
    label = `${start.getUTCFullYear()}`;
  } else {
    throw new Error('unsupported_period');
  }

  return { period, offset, start, end, label };
}

function isoWeekNumber(date) {
  // ISO week: week 1 contains Jan 4
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = tmp.getUTCDay() === 0 ? 7 : tmp.getUTCDay();
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
}

// ─── Per-case scoring ─────────────────────────────────────

function caseTimelyCoef(caseRow) {
  // v3.7: 三段 — 提早完成（closedOn ≤ goLive − 1 日）/ 準時 / 逾期
  if (!caseRow.closedOn || !caseRow.goLiveDate) return TIMELY_COEF.onTime;
  const closed = new Date(caseRow.closedOn).getTime();
  const due = new Date(caseRow.goLiveDate).getTime();
  const earlyCutoff = due - EARLY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  if (closed <= earlyCutoff) return TIMELY_COEF.early;
  return closed <= due ? TIMELY_COEF.onTime : TIMELY_COEF.overdue;
}
function caseTimelyLabel(caseRow) {
  const c = caseTimelyCoef(caseRow);
  if (c === TIMELY_COEF.early) return 'early';
  if (c === TIMELY_COEF.onTime) return 'onTime';
  return 'overdue';
}

function caseUrgentCoef(caseRow) {
  return caseRow.urgent ? URGENT_COEF.urgent : URGENT_COEF.normal;
}

function caseLevelWeight(caseRow) {
  return LEVEL_WEIGHT[caseRow.level] ?? 1;
}

/**
 * Score a single case for one staff member. role = 'primary' | 'collaborator'.
 */
export function scoreCaseForStaff(caseRow, role) {
  return (
    caseLevelWeight(caseRow) *
    (ROLE_COEF[role] ?? 0) *
    caseTimelyCoef(caseRow) *
    caseUrgentCoef(caseRow)
  );
}

// ─── Period rollup ────────────────────────────────────────

/**
 * Aggregate analytics for the given period.
 * Returns:
 *   {
 *     period: { period, offset, start, end, label },
 *     perStaff: [{
 *       staffId, name, seniority, role, active,
 *       primary:    { count, score },
 *       collab:     { count, score },
 *       totalCount, totalScore,
 *       onTimeCount, overdueCount, onTimeRate,
 *       urgentCount,
 *       byLevel: { SS: n, S: n, A: n, B: n, C: n, D: n },
 *     }],
 *     totals: { count, score, onTimeRate, byLevel },
 *     cases:  [{ id, title, level, designer, designerId, closedOn, goLiveDate, urgent, score }]
 *   }
 */
export async function rollup({ period, offset, staffId }) {
  const win = resolvePeriod(period, offset);

  const where = {
    status: { in: ['done', 'closed'] }, // v3.6: closed cases also count
    closedOn: { gte: win.start, lt: win.end },
  };

  const [staff, cases] = await Promise.all([
    prisma.staff.findMany({ orderBy: { id: 'asc' } }),
    prisma.case.findMany({
      where,
      include: {
        designer: { select: { id: true, name: true } },
        collaborators: { select: { id: true, name: true } },
      },
      orderBy: { closedOn: 'asc' },
    }),
  ]);

  // Build per-staff buckets
  const buckets = new Map();
  for (const s of staff) {
    buckets.set(s.id, {
      staffId: s.id,
      name: s.name,
      seniority: s.seniority,
      role: s.role,
      active: s.active,
      primary: { count: 0, score: 0 },
      collab: { count: 0, score: 0 },
      earlyCount: 0,
      totalCount: 0,
      totalScore: 0,
      onTimeCount: 0,
      overdueCount: 0,
      onTimeRate: 0,
      urgentCount: 0,
      byLevel: { SS: 0, S: 0, A: 0, B: 0, C: 0, D: 0 },
    });
  }

  let depTotalScore = 0;
  let depTotalCount = 0;
  let depOnTime = 0;
  let depEarly = 0;
  const depByLevel = { SS: 0, S: 0, A: 0, B: 0, C: 0, D: 0 };
  const caseList = [];

  for (const c of cases) {
    const timelyLabel = caseTimelyLabel(c);
    const onTime = timelyLabel !== 'overdue';
    const early = timelyLabel === 'early';
    depTotalCount += 1;
    if (onTime) depOnTime += 1;
    if (early) depEarly += 1;
    depByLevel[c.level] = (depByLevel[c.level] ?? 0) + 1;
    depTotalScore += scoreCaseForStaff(c, 'primary'); // department total uses primary basis

    // Primary
    const pBucket = buckets.get(c.designerId);
    if (pBucket) {
      const s = scoreCaseForStaff(c, 'primary');
      pBucket.primary.count += 1;
      pBucket.primary.score += s;
      pBucket.totalCount += 1;
      pBucket.totalScore += s;
      pBucket.byLevel[c.level] = (pBucket.byLevel[c.level] ?? 0) + 1;
      if (onTime) pBucket.onTimeCount += 1;
      else pBucket.overdueCount += 1;
      if (early) pBucket.earlyCount = (pBucket.earlyCount || 0) + 1;
      if (c.urgent) pBucket.urgentCount += 1;
    }

    // Collaborators
    for (const co of c.collaborators) {
      const cb = buckets.get(co.id);
      if (!cb) continue;
      const s = scoreCaseForStaff(c, 'collaborator');
      cb.collab.count += 1;
      cb.collab.score += s;
      cb.totalScore += s;
      // collab cases do NOT add to the totalCount (which is "lead cases")
      // but DO add to score; that mirrors how managers usually read it.
    }

    caseList.push({
      id: c.id,
      title: c.title,
      subTitle: c.subTitle,
      level: c.level,
      urgent: c.urgent,
      goLiveDate: c.goLiveDate,
      closedOn: c.closedOn,
      designerId: c.designerId,
      designerName: c.designer?.name,
      collaboratorNames: c.collaborators.map((x) => x.name),
      onTime,
      early,
      timely: timelyLabel, // 'early' | 'onTime' | 'overdue'
      score: scoreCaseForStaff(c, 'primary'),
    });
  }

  // Compute on-time rate per staff
  for (const b of buckets.values()) {
    const denom = b.onTimeCount + b.overdueCount;
    b.onTimeRate = denom === 0 ? null : b.onTimeCount / denom;
    // round score to 2 decimals for cleanliness
    b.primary.score = round2(b.primary.score);
    b.collab.score = round2(b.collab.score);
    b.totalScore = round2(b.totalScore);
  }

  let perStaff = Array.from(buckets.values());
  if (staffId) perStaff = perStaff.filter((b) => b.staffId === Number(staffId));
  // sort by totalScore desc
  perStaff.sort((a, b) => b.totalScore - a.totalScore);

  return {
    period: win,
    perStaff,
    totals: {
      count: depTotalCount,
      score: round2(depTotalScore),
      onTimeRate: depTotalCount === 0 ? null : depOnTime / depTotalCount,
      earlyCount: depEarly,
      earlyRate: depTotalCount === 0 ? null : depEarly / depTotalCount,
      byLevel: depByLevel,
    },
    cases: caseList,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
