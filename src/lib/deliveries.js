// REPORTS-P1-A: delivery evidence (case_deliveries).
//
// Records are append-only: correction = void (one-time stamp with reason) + append.
// Every mutation runs in one Serializable transaction that re-reads the actor, the
// case snapshot, assignment and state, writes the record and advances the case
// version together. The client-supplied id (or void requestId) is the idempotency
// key: the same actor/case/content replays the stored result, anything else conflicts.
// Legacy requestCount/outputCount are reported as-is and never overwritten here.
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db.js';
import { CaseEditError } from './caseJsonEdits.js';
import { ITEM_KEY_PATTERN } from './caseItemKeys.js';
import { taipeiCalendarDay } from '../services/analytics.js';
import { deliveryFlags } from './deliveryFlags.js';
import { assertLifecycle, assertCycle } from './caseLifecycle.js';

export const DELIVERY_KINDS = ['main', 'extension', 'support'];
export const DELIVERY_UNITS = ['件'];
export const MAX_DELIVERY_QUANTITY = 1000000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
// States in which A accepts no new delivery mutations (review/approval semantics arrive in C).
const LOCKED_STATUSES = new Set(['review_done', 'done', 'closed', 'cancelled']);

const fail = (status, code, message) => new CaseEditError(status, code, message);
const conflict = () => fail(409, 'edit_conflict', '案件已被其他操作更新，請重新載入後再試；這次沒有寫入。');
const requestConflict = () => fail(409, 'delivery_request_conflict', '這個送出識別碼已用於其他內容；既有紀錄未更動，請重新整理後再送出。');

export function realCalendarDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(text + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
}
const ymd = value => (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
const trimmedOrNull = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
// "Meaningful": at least four characters that are not only punctuation, digits or placeholders.
export function meaningfulNote(note) {
  const text = trimmedOrNull(note);
  if (!text || text.length < 4) return false;
  if (/^[\s\p{P}\p{S}\d]+$/u.test(text)) return false;
  return !/^(n\/?a|none|null|tbd|todo|test|無|沒有|略|同上|待補|不適用)$/i.test(text);
}

const createSchema = z.object({
  id: z.string().regex(REQUEST_ID, 'id 需為 8–100 個英數、底線或連字號'),
  itemKey: z.string().regex(ITEM_KEY_PATTERN, 'itemKey 格式不正確').nullable().optional(),
  itemName: z.string().trim().min(1, '品名不可空白').max(200).optional(),
  kind: z.enum(DELIVERY_KINDS),
  quantity: z.number().int('數量需為整數').min(0, '數量不可小於 0').max(MAX_DELIVERY_QUANTITY, '數量不可超過 1,000,000'),
  unit: z.enum(DELIVERY_UNITS).default('件'),
  deliveredOn: z.string(),
  note: z.string().max(1000).nullable().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedContentVersion: z.number().int().nonnegative(),
  expectedCycleId: z.string().regex(REQUEST_ID).nullable().optional(), // REPORTS-P2-D1b: required on lifecycle-managed cases
}).strict();
// REPORTS-P1-B: atomic correction = replacement create fields + a required correction reason.
const replaceSchema = createSchema.extend({ reason: z.string().trim().min(2, '更正原因至少 2 個字').max(500) }).strict();
const voidSchema = z.object({
  requestId: z.string().regex(REQUEST_ID, 'requestId 需為 8–100 個英數、底線或連字號'),
  reason: z.string().trim().min(2, '作廢原因至少 2 個字').max(500),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedContentVersion: z.number().int().nonnegative(),
  expectedCycleId: z.string().regex(REQUEST_ID).nullable().optional(), // REPORTS-P2-D1b
}).strict();

function invalid(issues) { return Object.assign(fail(400, 'invalid_body', '交付內容格式不正確'), { issues }); }

// Returns a normalized create request or throws a 400/422 CaseEditError.
export function parseCreate(body, today = taipeiCalendarDay(), schema = createSchema) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const input = { ...parsed.data, itemKey: parsed.data.itemKey ?? null, note: trimmedOrNull(parsed.data.note) };
  const date = realCalendarDate(input.deliveredOn);
  if (!date) throw invalid([{ path: ['deliveredOn'], message: '交付日期需為有效的 YYYY-MM-DD' }]);
  if (date < new Date('2000-01-01T00:00:00Z')) throw fail(422, 'delivered_on_out_of_range', '交付日期不可早於 2000-01-01');
  if (date.getTime() > today.getTime()) throw fail(422, 'delivered_on_future', '交付日期不可晚於今天（台北時間）');
  input.deliveredDate = date;
  if (!input.itemKey && !input.itemName) throw fail(422, 'item_name_required', '未指定子案件時，請填寫交付品名');
  if (input.quantity === 0) {
    if (input.kind !== 'support') throw fail(422, 'zero_output_kind', '主設計與延伸的數量至少為 1；沒有設計產出請選「支援」並說明');
    if (!meaningfulNote(input.note)) throw fail(422, 'zero_output_note_required', '數量為 0 的支援工作需填寫具體說明（至少 4 個字）');
  }
  return input;
}
export function parseVoid(body) {
  const parsed = voidSchema.safeParse(body);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return parsed.data;
}

export function serializeRecord(r) {
  return {
    id: r.id, caseId: r.caseId, itemKey: r.itemKey, itemName: r.itemName, kind: r.kind, quantity: r.quantity, unit: r.unit,
    deliveredOn: ymd(r.deliveredOn), note: r.note, recordedById: r.recordedById, recordedByName: r.recordedByName,
    createdAt: new Date(r.createdAt).toISOString(), voided: !!r.voidedAt,
    voidedAt: r.voidedAt ? new Date(r.voidedAt).toISOString() : null, voidedById: r.voidedById ?? null,
    voidedByName: r.voidedByName ?? null, voidReason: r.voidReason ?? null,
    cycleId: r.cycleId ?? null, // REPORTS-P2-D1b: null = legacy / unknown attribution
  };
}
// Grouped by kind and unit only; unlike types are never summed into one score.
export function summarize(records) {
  const active = records.filter(r => !r.voidedAt);
  const groups = [];
  for (const kind of DELIVERY_KINDS) for (const unit of DELIVERY_UNITS) {
    const rows = active.filter(r => r.kind === kind && r.unit === unit);
    if (rows.length) groups.push({ kind, unit, quantity: rows.reduce((sum, r) => sum + r.quantity, 0), records: rows.length });
  }
  const dates = active.map(r => ymd(r.deliveredOn)).sort();
  return {
    status: active.length ? 'recorded' : 'unknown', // no records = unknown, never 0
    groups, activeRecords: active.length, voidedRecords: records.length - active.length,
    zeroSupportRecords: active.filter(r => r.kind === 'support' && r.quantity === 0).length,
    firstDeliveredOn: dates[0] || null, lastDeliveredOn: dates.at(-1) || null,
  };
}

export async function listDeliveries(caseId) {
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true, updatedAt: true, contentVersion: true, requestCount: true, outputCount: true, deliveryMode: true, status: true, pendingDeliverySubmissionId: true, lifecycleMode: true, lifecycleStatus: true, currentCycleId: true, pendingLifecycleRequestId: true } });
  if (!row) throw fail(404, 'not_found', '找不到案件');
  const records = await prisma.deliveryRecord.findMany({ where: { caseId }, orderBy: [{ deliveredOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
  return {
    caseId: row.id, updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion,
    // REPORTS-P2-D2: cycle + lifecycle read in the SAME row as the versions above (one consistent snapshot for writers).
    lifecycleMode: row.lifecycleMode || 'legacy', lifecycleStatus: row.lifecycleStatus ?? null, currentCycleId: row.currentCycleId ?? null,
    pendingLifecycleRequestId: row.pendingLifecycleRequestId ?? null,
    // REPORTS-P1-C1: non-secret mode/workflow information for the drawer (C2).
    mode: row.deliveryMode || 'legacy', status: row.status, pendingSubmissionId: row.pendingDeliverySubmissionId ?? null,
    workflow: (() => { const f = deliveryFlags(); return { ...f, paused: row.deliveryMode === 'records' && !f.workflowActive }; })(),
    records: records.map(serializeRecord), summary: summarize(records),
    // Legacy totals keep their historical meaning; they are not derived from or synced with records.
    legacy: {
      requestCount: row.requestCount, outputCount: row.outputCount,
      requestCountStatus: row.requestCount == null ? 'unknown' : 'legacy_total',
      outputCountStatus: row.outputCount == null ? 'unknown' : 'legacy_total',
    },
  };
}

async function loadActor(tx, user) {
  const actor = await tx.staff.findUnique({ where: { id: user?.id ?? -1 }, select: { id: true, name: true, role: true, active: true, pendingActivation: true } });
  if (!actor || !actor.active || actor.pendingActivation) throw fail(403, 'actor_inactive', '帳號已停用或尚未啟用，無法登錄交付');
  if (actor.role === 'observer') throw fail(403, 'read_only', '觀察者帳號為唯讀');
  return actor;
}
// REPORTS-P2-D1b: on a lifecycle-managed case a delivery write also needs an active lifecycle without a pending
// seal/resume request and the browser's current cycle id (checked inside this transaction).
async function loadOpenCase(tx, actor, caseId, expectedUpdatedAt, expectedContentVersion, expectedCycleId) {
  const row = await tx.case.findUnique({ where: { id: caseId }, include: { collaborators: { select: { id: true } } } });
  // REPORTS-P2-D1b: lock the case row before ANY delivery write (consistent lock order; the 0006 attribution trigger
  // re-locks it on insert). Delivery writes are thereby serialized against lifecycle writes on the same case without
  // the insert-then-update lock inversion that deadlocks two overlapping corrections; a concurrent committed change
  // surfaces as a serialization failure (existing replay/409 handling). The in-memory test doubles serialize whole
  // transactions and have no raw SQL, hence the capability check.
  if (row && typeof tx.$queryRawUnsafe === 'function') {
    try { await tx.$queryRawUnsafe('SELECT 1 FROM "cases" WHERE "id" = $1 FOR UPDATE', caseId); }
    catch (e) {   // a raw query reports serialization/deadlock as P2010 + SQLSTATE; treat it like P2034 (replay / 409)
      if (/40001|40P01/.test(String(e?.message || '')) || e?.meta?.code === '40001' || e?.meta?.code === '40P01') throw Object.assign(new Error('serialization failure'), { code: 'P2034' });
      throw e;
    }
  }
  if (!row) throw fail(404, 'not_found', '找不到案件');
  if (actor.role !== 'admin' && row.designerId !== actor.id && !row.collaborators.some(c => c.id === actor.id)) {
    throw fail(403, 'forbidden', '只有主負責人、協作者或管理員可登錄交付');
  }
  if (row.archived || LOCKED_STATUSES.has(row.status)) throw fail(409, 'case_locked', '案件已送核可、結案、取消或封存，這一批不開放新增或作廢交付');
  assertLifecycle(row, 'evidence');
  if (row.contentVersion !== expectedContentVersion || new Date(expectedUpdatedAt).getTime() !== new Date(row.updatedAt).getTime()) throw conflict();
  assertCycle(row, expectedCycleId);
  return row;
}
const cycleFor = row => (row.lifecycleMode === 'managed' ? row.currentCycleId : null);
// Earlier-cycle deliveries are closed evidence: the ordinary void / correction paths may only touch records of the
// current cycle (or, in cycle 1, records whose attribution is unknown because they predate adoption).
async function assertCurrentCycleRecord(tx, row, record) {
  if (row.lifecycleMode !== 'managed' || record.cycleId === row.currentCycleId) return;
  if (record.cycleId == null) {
    const cycle = await tx.caseCycle.findUnique({ where: { id: row.currentCycleId } });
    if (cycle?.sequence === 1) return;
  }
  throw fail(409, 'delivery_previous_cycle', '這筆交付屬於先前的工作週期，本批不提供前期交付更正；紀錄已保留。');
}
async function advanceCase(tx, row) {
  const previous = new Date(row.updatedAt);
  const next = new Date(Math.max(Date.now(), previous.getTime() + 1));
  const claimed = await tx.case.updateMany({ where: { id: row.id, updatedAt: previous, contentVersion: row.contentVersion }, data: { updatedAt: next, contentVersion: { increment: 1 } } });
  if (claimed.count !== 1) throw conflict();
  return { id: row.id, updatedAt: next.toISOString(), contentVersion: row.contentVersion + 1 };
}
async function caseVersion(caseId) {
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true, updatedAt: true, contentVersion: true } });
  return row ? { id: row.id, updatedAt: new Date(row.updatedAt).toISOString(), contentVersion: row.contentVersion } : null;
}
const serializable = fn => prisma.$transaction(fn, { isolationLevel: 'Serializable' });
const retryable = e => e?.code === 'P2002' || e?.code === 'P2034';

// Exact normalized request intent. Omitting itemName is part of the intent (the server derives
// the name from the item), so it is fingerprinted as "not supplied", never as a wildcard; a later
// item rename therefore cannot change the fingerprint of an exact retry.
export function deliveryFingerprint(actorId, caseId, input) {
  const intent = ['delivery.v1', caseId, actorId, input.itemKey ?? null, input.itemName === undefined ? null : input.itemName,
    input.itemName !== undefined, input.kind, input.quantity, input.unit, input.deliveredOn, input.note ?? null,
    ...(input.expectedCycleId != null ? [input.expectedCycleId] : [])]; // D1b: bound to the cycle (legacy intent unchanged)
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
async function replayCreate(prior, user, caseId, input) {
  if (prior.requestFingerprint !== deliveryFingerprint(user.id, caseId, input)) throw requestConflict();
  return { status: 200, replayed: true, record: serializeRecord(prior), case: await caseVersion(caseId) };
}

export async function createDelivery(user, caseId, input) {
  try {
    return await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const prior = await tx.deliveryRecord.findUnique({ where: { id: input.id } });
      if (prior) return { prior };
      const row = await loadOpenCase(tx, actor, caseId, input.expectedUpdatedAt, input.expectedContentVersion, input.expectedCycleId);
      let itemName = input.itemName;
      if (input.itemKey) {
        const item = (Array.isArray(row.items) ? row.items : []).find(it => it && typeof it === 'object' && it.key === input.itemKey);
        if (!item) throw fail(422, 'item_key_unknown', '指定的子案件不存在於此案件，請重新載入後再登錄');
        itemName = itemName ?? (String(item.n ?? '').trim() || null);
        if (!itemName) throw fail(422, 'item_name_required', '子案件沒有名稱，請填寫交付品名');
      }
      const record = await tx.deliveryRecord.create({ data: {
        id: input.id, caseId, itemKey: input.itemKey, itemName, kind: input.kind, quantity: input.quantity, unit: input.unit,
        deliveredOn: input.deliveredDate, note: input.note, recordedById: actor.id, recordedByName: actor.name,
        requestFingerprint: deliveryFingerprint(actor.id, caseId, input), cycleId: cycleFor(row),
      } });
      const version = await advanceCase(tx, row);
      return { status: 201, replayed: false, record: serializeRecord(record), case: version };
    }).then(async result => (result.prior ? replayCreate(result.prior, user, caseId, input) : result));
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      // A concurrent identical request may have won; the stored row decides replay vs conflict.
      const prior = await prisma.deliveryRecord.findUnique({ where: { id: input.id } });
      if (prior) return replayCreate(prior, user, caseId, input);
      throw conflict();
    }
    throw e;
  }
}

async function replayVoid(record, user, caseId, input) {
  if (record.voidRequestId === input.requestId && record.voidedById === user.id && record.voidReason === input.reason && record.caseId === caseId) {
    return { status: 200, replayed: true, record: serializeRecord(record), case: await caseVersion(caseId) };
  }
  if (record.voidRequestId === input.requestId) throw requestConflict();
  throw fail(409, 'delivery_already_voided', '這筆交付已被作廢，未再次變更');
}

export async function voidDelivery(user, caseId, recordId, input) {
  try {
    return await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const record = await tx.deliveryRecord.findUnique({ where: { id: recordId } });
      if (!record || record.caseId !== caseId) throw fail(404, 'delivery_not_found', '找不到這筆交付紀錄');
      if (record.voidedAt) return { voided: record };
      const used = await tx.deliveryRecord.findUnique({ where: { voidRequestId: input.requestId } });
      if (used) throw requestConflict();
      const row = await loadOpenCase(tx, actor, caseId, input.expectedUpdatedAt, input.expectedContentVersion, input.expectedCycleId);
      await assertCurrentCycleRecord(tx, row, record);
      const stamped = await tx.deliveryRecord.updateMany({ where: { id: recordId, voidedAt: null }, data: {
        voidedAt: new Date(), voidedById: actor.id, voidedByName: actor.name, voidReason: input.reason, voidRequestId: input.requestId,
      } });
      if (stamped.count !== 1) throw conflict();
      const version = await advanceCase(tx, row);
      const updated = await tx.deliveryRecord.findUnique({ where: { id: recordId } });
      return { status: 200, replayed: false, record: serializeRecord(updated), case: version };
    }).then(async result => (result.voided ? replayVoid(result.voided, user, caseId, input) : result));
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const record = await prisma.deliveryRecord.findUnique({ where: { id: recordId } });
      if (record?.voidedAt) return replayVoid(record, user, caseId, input);
      throw conflict();
    }
    throw e;
  }
}

// ─── REPORTS-P1-B: atomic correction (replace) ───────────────────────────────
// One Serializable transaction creates the replacement, stamps the original void
// (voidRequestId = replacement id, voidReason = correction reason) and advances the case
// version once. The replacement row stores an operation-specific fingerprint binding actor,
// case, original id, reason and the replacement intent, so only the identical correction
// replays; a plain create with the same id (different tag) never counts as a replacement.
export function parseReplace(body, today = taipeiCalendarDay()) {
  const input = parseCreate(body, today, replaceSchema);
  return input;
}
export function replaceFingerprint(actorId, caseId, originalId, input) {
  const intent = ['delivery.replace.v1', caseId, actorId, originalId, input.reason, input.itemKey ?? null,
    input.itemName === undefined ? null : input.itemName, input.itemName !== undefined, input.kind, input.quantity,
    input.unit, input.deliveredOn, input.note ?? null, ...(input.expectedCycleId != null ? [input.expectedCycleId] : [])];
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
async function replayReplace(prior, user, caseId, originalId, input) {
  if (prior.requestFingerprint !== replaceFingerprint(user.id, caseId, originalId, input)) throw requestConflict();
  const original = await prisma.deliveryRecord.findUnique({ where: { id: originalId } });
  if (!original || original.voidRequestId !== prior.id) throw requestConflict();
  return { status: 200, replayed: true, original: serializeRecord(original), replacement: serializeRecord(prior), case: await caseVersion(caseId) };
}
export async function replaceDelivery(user, caseId, originalId, input) {
  try {
    return await serializable(async tx => {
      const actor = await loadActor(tx, user);
      const prior = await tx.deliveryRecord.findUnique({ where: { id: input.id } });
      if (prior) return { prior };
      const original = await tx.deliveryRecord.findUnique({ where: { id: originalId } });
      if (!original || original.caseId !== caseId) throw fail(404, 'delivery_not_found', '找不到要更正的交付紀錄');
      if (original.voidedAt) throw fail(409, 'delivery_already_voided', '這筆交付已被作廢或更正，未再次變更；請重新整理明細');
      const row = await loadOpenCase(tx, actor, caseId, input.expectedUpdatedAt, input.expectedContentVersion, input.expectedCycleId);
      await assertCurrentCycleRecord(tx, row, original);
      let itemName = input.itemName;
      if (input.itemKey) {
        const item = (Array.isArray(row.items) ? row.items : []).find(it => it && typeof it === 'object' && it.key === input.itemKey);
        if (!item) throw fail(422, 'item_key_unknown', '指定的子案件不存在於此案件，請重新載入後再登錄');
        itemName = itemName ?? (String(item.n ?? '').trim() || null);
        if (!itemName) throw fail(422, 'item_name_required', '子案件沒有名稱，請填寫交付品名');
      }
      const replacement = await tx.deliveryRecord.create({ data: {
        id: input.id, caseId, itemKey: input.itemKey, itemName, kind: input.kind, quantity: input.quantity, unit: input.unit,
        deliveredOn: input.deliveredDate, note: input.note, recordedById: actor.id, recordedByName: actor.name,
        requestFingerprint: replaceFingerprint(actor.id, caseId, originalId, input), cycleId: cycleFor(row),
      } });
      const stamped = await tx.deliveryRecord.updateMany({ where: { id: originalId, voidedAt: null }, data: {
        voidedAt: new Date(), voidedById: actor.id, voidedByName: actor.name, voidReason: input.reason, voidRequestId: input.id,
      } });
      if (stamped.count !== 1) throw conflict();
      const version = await advanceCase(tx, row);
      const updatedOriginal = await tx.deliveryRecord.findUnique({ where: { id: originalId } });
      return { status: 201, replayed: false, original: serializeRecord(updatedOriginal), replacement: serializeRecord(replacement), case: version };
    }).then(async result => (result.prior ? replayReplace(result.prior, user, caseId, originalId, input) : result));
  } catch (e) {
    if (e instanceof CaseEditError) throw e;
    if (retryable(e)) {
      const prior = await prisma.deliveryRecord.findUnique({ where: { id: input.id } });
      if (prior) return replayReplace(prior, user, caseId, originalId, input);
      throw conflict();
    }
    throw e;
  }
}

// Linked keys = keys referenced by non-voided records (voided evidence keeps its snapshot).
export async function linkedItemKeys(client, caseId) {
  const rows = await client.deliveryRecord.findMany({ where: { caseId, voidedAt: null, itemKey: { not: null } }, select: { itemKey: true } });
  return new Set(rows.map(r => r.itemKey));
}
