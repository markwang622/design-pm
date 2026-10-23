// Case ID generator: {LEVEL}-{YYYY}-{MM}-{SEQ:03d}.
// Read numeric suffixes: lexical order stops advancing when 999 becomes 1000.
import { prisma } from './db.js';

export async function nextCaseId(level, date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const prefix = `${level}-${y}-${m}-`;
  const rows = await prisma.case.findMany({
    where: { id: { startsWith: prefix } },
    select: { id: true },
  });
  let highest = 0n;
  for (const row of rows) {
    const suffix = row.id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const seq = BigInt(suffix);
    if (seq > highest) highest = seq;
  }
  return `${prefix}${String(highest + 1n).padStart(3, '0')}`;
}

// The unique Case.id constraint arbitrates concurrent allocation. Rebuild the
// complete create data after a collision so ID-derived fields stay consistent.
export async function createWithCaseId(level, date, create) {
  for (let attempt = 0; ; attempt++) {
    const id = await nextCaseId(level, date);
    try { return await create(id); }
    catch (e) {
      const target = e.meta?.target;
      const idConflict = !target || (Array.isArray(target) ? target.includes('id') : /(?:^id$|_pkey$)/.test(String(target)));
      if (e.code === 'P2002' && idConflict && attempt < 4) continue;
      throw e;
    }
  }
}
