// ─────────────────────────────────────────────────────────────
// Workload calculation + successor suggestion
// Matches PRD §6.1 – §6.3
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';

export const LEVEL_WEIGHT = { SS: 5, S: 4, A: 3, B: 2, C: 1, D: 1 };
const SENIORITY_RANK = { senior: 0, mid: 1, junior: 2 };

/**
 * Compute workload score for a given staff member.
 * Primary (designer) = weight × 1.0
 * Collaborator       = weight × 0.4
 * Only counts active (non-done, non-archived) cases.
 */
export async function workloadScore(staffId) {
  const [owned, collab] = await Promise.all([
    prisma.case.findMany({
      where: { designerId: staffId, archived: false, status: { notIn: ['done', 'closed'] } },
      select: { level: true },
    }),
    prisma.case.findMany({
      where: {
        archived: false,
        status: { notIn: ['done', 'closed'] },
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
 * Compute workload for every active staff member.
 * Returns array of { id, name, seniority, score } sorted by score ascending.
 */
export async function workloadForAll({ excludeId } = {}) {
  const staff = await prisma.staff.findMany({
    where: { active: true, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true, name: true, seniority: true },
    orderBy: { id: 'asc' },
  });
  const rows = await Promise.all(
    staff.map(async (s) => ({ ...s, score: await workloadScore(s.id) }))
  );
  rows.sort((a, b) => a.score - b.score);
  return rows;
}

/**
 * Suggest a successor for a case being transferred from `excludeId`.
 * Rule: lowest workload wins. Tie-break: for SS/S cases, prefer higher seniority.
 */
export async function suggestSuccessor({ excludeId, level }) {
  const ranked = await workloadForAll({ excludeId });
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
