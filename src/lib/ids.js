// Case ID generator: {LEVEL}-{YYYY}-{MM}-{SEQ:03d}
// Uses the existing Cases table to find the highest seq for the given level+month.
import { prisma } from './db.js';

export async function nextCaseId(level, date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const prefix = `${level}-${y}-${m}-`;

  const latest = await prisma.case.findFirst({
    where: { id: { startsWith: prefix } },
    orderBy: { id: 'desc' },
    select: { id: true },
  });

  let seq = 1;
  if (latest) {
    const tail = latest.id.slice(prefix.length); // "003"
    seq = parseInt(tail, 10) + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}
