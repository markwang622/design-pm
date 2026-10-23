// ─────────────────────────────────────────────────────────────
// Workload calculation + successor suggestion
// Matches PRD §6.1 – §6.3
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';

export const LEVEL_WEIGHT = { SS: 5, S: 4, A: 3, B: 2, C: 1, D: 1 };
const SENIORITY_RANK = { senior: 0, mid: 1, junior: 2 };
const TERMINAL_STATUSES = ['done', 'closed', 'cancelled'];

/**
 * Compute workload score for a given staff member.
 * Primary (designer) = weight × 1.0
 * Collaborator       = weight × 0.4
 * Only counts active (non-done, non-archived) cases.
 */
export async function workloadScore(staffId) {
  const [owned, collab] = await Promise.all([
    prisma.case.findMany({
      where: { designerId: staffId, archived: false, status: { notIn: TERMINAL_STATUSES } },
      select: { level: true },
    }),
    prisma.case.findMany({
      where: {
        archived: false,
        status: { notIn: TERMINAL_STATUSES },
        collaborators: { some: { id: staffId } },
        NOT: { designerId: staffId },
      },
      select: { level: true },
    }),
  ]);

  const primary = owned.reduce((s, c) => s + (LEVEL_WEIGHT[c.level] ?? 1), 0);
  const collaborative = collab.reduce((s, c) => s + (LEVEL_WEIGHT[c.level] ?? 1) * 0.4, 0);
  return Math.round((primary + collaborative) * 10) / 10;
}

/**
 * Score a selected roster with one case read, regardless of roster size. Only
 * participation in active cases matters; stable IDs keep names out of scoring.
 */
export async function workloadScores(staffIds) {
  const ids = [...new Set(staffIds)];
  const tenths = new Map(ids.map(id => [id, 0]));
  if (!ids.length) return tenths;
  const cases = await prisma.case.findMany({
    where: {
      archived: false, status: { notIn: TERMINAL_STATUSES },
      OR: [{ designerId: { in: ids } }, { collaborators: { some: { id: { in: ids } } } }],
    },
    select: { level: true, designerId: true, collaborators: { select: { id: true } } },
  });
  for (const c of cases) {
    const weight = LEVEL_WEIGHT[c.level] ?? 1;
    if (tenths.has(c.designerId)) tenths.set(c.designerId, tenths.get(c.designerId) + weight * 10);
    // A case counts once per collaborator, even in legacy duplicate fixtures;
    // an owner who also appears in collaborators receives only primary credit.
    const collaborators = new Set(c.collaborators.map(s => s.id));
    for (const id of collaborators) {
      if (id !== c.designerId && tenths.has(id)) tenths.set(id, tenths.get(id) + weight * 4);
    }
  }
  // Integer tenths avoid repeated floating-point additions while preserving the
  // original one-decimal score for primary weight + 40% collaborator weight.
  return new Map([...tenths].map(([id, score]) => [id, score / 10]));
}

/**
 * Compute workload for every active staff member.
 * Returns array of { id, name, seniority, score } sorted by score ascending.
 */
export async function workloadForAll({ excludeId, assignableOnly = false } = {}) {
  const staff = await prisma.staff.findMany({
    where: { active: true, ...(excludeId ? { NOT: { id: excludeId } } : {}),
      ...(assignableOnly ? { pendingActivation: false, role: { in: ['admin', 'member'] } } : {}) },
    select: { id: true, name: true, seniority: true },
    orderBy: { id: 'asc' },
  });
  const scores = await workloadScores(staff.map(s => s.id));
  const rows = staff.map(s => ({ ...s, score: scores.get(s.id) ?? 0 }));
  rows.sort((a, b) => a.score - b.score);
  return rows;
}

/**
 * Suggest a successor for a case being transferred from `excludeId`.
 * Rule: lowest workload wins. Tie-break: for SS/S cases, prefer higher seniority.
 */
export async function suggestSuccessor({ excludeId, level }) {
  const ranked = await workloadForAll({ excludeId, assignableOnly: true });
  return pickSuccessorFromRanking(ranked, level);
}

// Pure selection lets departure previews reuse one unchanged workload snapshot
// for every case, preserving the existing score and seniority tie-break rules.
export function pickSuccessorFromRanking(ranked, level) {
  if (ranked.length === 0) return null;

  const minScore = ranked[0].score;
  let tied = ranked.filter((r) => r.score === minScore);

  if (['SS', 'S'].includes(level)) {
    tied = tied.sort(
      (a, b) => (SENIORITY_RANK[a.seniority] ?? 9) - (SENIORITY_RANK[b.seniority] ?? 9)
    );
  }
  return tied[0];
}
