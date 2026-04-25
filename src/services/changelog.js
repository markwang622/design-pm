// ─────────────────────────────────────────────────────────────
// ChangeLog service — writes audit rows when tracked fields
// change on a Case.
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';

// Fields that REQUIRE a reason on PATCH
export const TRACKED_FIELDS = [
  'goLiveDate',
  'dispatchDate',
  'copyDate',
  'designerId',
  'status',
  'level',
  'urgent',
];

const dateLike = (v) => v instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(v ?? ''));

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// Compare existing-row value vs incoming-patch value.
// Returns true if they differ in a meaningful way.
function diff(field, before, after) {
  if (after === undefined) return false;
  if (dateLike(before) || dateLike(after)) {
    return fmt(before) !== fmt(after);
  }
  return before !== after;
}

/**
 * Detect which tracked fields are changing.
 * @param {object} existing - the current row (Prisma case)
 * @param {object} patch    - validated update payload
 * @returns {Array<{field:string, fromValue:string, toValue:string}>}
 */
export function detectChanges(existing, patch) {
  const out = [];
  for (const field of TRACKED_FIELDS) {
    if (patch[field] === undefined) continue;
    if (!diff(field, existing[field], patch[field])) continue;
    out.push({
      field,
      fromValue: fmt(existing[field]),
      toValue: fmt(patch[field]),
    });
  }
  return out;
}

/**
 * Write a batch of ChangeLog rows.
 * @param {string} caseId
 * @param {Array<{field, fromValue, toValue}>} changes
 * @param {string} reason
 * @param {string} operator
 */
export async function writeChangeLog(caseId, changes, reason, operator) {
  if (!changes.length) return;
  await prisma.changeLog.createMany({
    data: changes.map((c) => ({
      caseId,
      field: c.field,
      fromValue: c.fromValue,
      toValue: c.toValue,
      reason,
      operator,
    })),
  });
}
