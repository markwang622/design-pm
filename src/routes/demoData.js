// ─────────────────────────────────────────────────────────────
// 暫用：把正式站專案資料複製到 Demo（v9.4）
//
// 啟用條件：APP_BASE_URL 必須「精確等於」demo 站網址，否則整組路由回 404，
// 在正式站上等同不存在。再加 admin-only。
//
// 流程：POST /preview（純唯讀，回報數量／衝突／缺漏關聯／字典異動＋digest）
//      → POST /import（需確認字串 + 同一份 payload 的 digest；伺服器重算比對）
// 全部寫入放在單一交易，關聯先驗證，任何一筆失敗整批 rollback。
//
// 明確不做：不複製密碼／token、不碰休假／通知／會議，不清空資料，
// 不產生邀請或 email，不覆蓋既有案號，不改既有登入帳號。
// ─────────────────────────────────────────────────────────────
import { safeRouter } from '../lib/safeRouter.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { unusablePassword } from '../lib/activation.js';

export const DEMO_ORIGIN = 'https://artdesign-for-demo.zeabur.app';
export const SOURCE_ORIGIN = 'https://artdesign.zeabur.app';
export const CONFIRM_PHRASE = 'COPY PRODUCTION PROJECT DATA TO DEMO';
const ALIAS_DOMAIN = 'demo.invalid';
const aliasEmail = (sourceId) => `source-${sourceId}@${ALIAS_DOMAIN}`;

const router = safeRouter(); // v9.6: async 錯誤一律交給 error middleware

// ── Gate 1：只在 demo 站存在 ──
router.use((req, res, next) => {
  if (process.env.APP_BASE_URL !== DEMO_ORIGIN) return res.status(404).json({ error: 'not_found' });
  next();
});
router.use(requireAuth);
router.use(requireAdmin);

// ── Gate 2：body 內任何敏感欄位一律拒絕（不論深度）──
const FORBIDDEN_KEY = /password|passwd|token|secret|cookie|session|hash/i;
function findForbiddenKey(v, path = '') {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = findForbiddenKey(v[i], `${path}[${i}]`); if (r) return r; } return null; }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEY.test(k)) return `${path}.${k}`;
      const r = findForbiddenKey(v[k], `${path}.${k}`); if (r) return r;
    }
  }
  return null;
}

// ── 輸入白名單 ──
const dateLike = z.union([z.string(), z.date()]).nullable().optional();
const staffSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(50),
  joined: z.union([z.string(), z.date()]),
  departedOn: dateLike,
  seniority: z.enum(['senior', 'mid', 'junior']),
  roleTitle: z.string().max(50).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  active: z.boolean().optional(),
}).strict();
const hotelSchema = z.object({
  name: z.string().min(1).max(50),
  region: z.string().min(1).max(20),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
}).passthrough();
const unitSchema = z.object({
  name: z.string().min(1).max(50),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
}).passthrough();
const staffRef = z.object({ id: z.number().int().positive() }).passthrough().nullable().optional();
const caseSchema = z.object({
  id: z.string().min(3).max(40),
  title: z.string().min(1).max(200),
  designerId: z.number().int().positive(),
  designer: staffRef,
  collaborators: z.array(z.object({ id: z.number().int().positive() }).passthrough()).max(10).optional(),
  createdById: z.number().int().positive().nullable().optional(),
  createdBy: staffRef,
}).passthrough();

const payloadSchema = z.object({
  sourceOrigin: z.literal(SOURCE_ORIGIN),
  staff: z.array(staffSchema).max(100),
  hotels: z.array(hotelSchema).max(100),
  units: z.array(unitSchema).max(100),
  cases: z.array(caseSchema).max(2000),
});

// 只會寫進 Case 的欄位（schema 之外的鍵一律丟棄）
const CASE_FIELDS = [
  'id', 'title', 'subTitle', 'requester', 'hotel', 'level', 'category', 'status', 'urgent', 'note',
  'contact', 'deliverables', 'needsOutsourcing', 'copyPath', 'source', 'requestedOn', 'openDate',
  'dispatchDate', 'copyDate', 'printDate', 'goLiveDate', 'archivePath', 'archived', 'closedOn',
  'cancelReason', 'cancelStage', 'cancelledOn', 'requestCount', 'outputCount', 'actualWorkdays',
  'items', 'logs', 'createdAt', 'updatedAt',
];
// 可空 Json 欄位：來源為 null 時必須交 Prisma.DbNull，直接給 JS null 會被 Prisma 拒絕
const JSON_FIELDS = new Set(['deliverables', 'items', 'logs']);
const DATE_FIELDS = new Set(['requestedOn', 'openDate', 'dispatchDate', 'copyDate', 'printDate', 'goLiveDate', 'closedOn', 'cancelledOn', 'createdAt', 'updatedAt', 'joined', 'departedOn']);
// items 內會指向 staff id 的欄位（名字欄位如 owner 原樣保留）
const ITEM_STAFF_ID_KEYS = ['assigneeId', 'ownerId', 'staffId', 'designerId'];

function toDate(v) { if (v === null || v === undefined || v === '') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }

// ── Digest：穩定序列化（鍵排序）後 sha256，preview 與 import 用同一演算法 ──
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export function payloadDigest(p) {
  return crypto.createHash('sha256').update(stable({ sourceOrigin: p.sourceOrigin, staff: p.staff, hotels: p.hotels, units: p.units, cases: p.cases })).digest('hex');
}

// ── 分析（純讀）：產生人員映射、衝突、缺漏、字典異動與要寫入的案件 ──
async function analyze(p, db = prisma) {
  const errors = [];
  const sourceIds = new Set(p.staff.map((s) => s.id));
  const dupOf = (arr) => [...new Set(arr.filter((x, i, a) => a.indexOf(x) !== i))];
  const dupIds = dupOf(p.staff.map((s) => s.id));
  if (dupIds.length) errors.push({ code: 'duplicate_source_staff_id', ids: dupIds, message: '來源人員 id 重複，映射不明確' });
  const dupNames = dupOf(p.staff.map((s) => s.name));
  if (dupNames.length) errors.push({ code: 'duplicate_source_name', names: dupNames });
  const dupHotels = dupOf(p.hotels.map((h) => h.name));
  if (dupHotels.length) errors.push({ code: 'duplicate_hotel_name', names: dupHotels });
  const dupUnits = dupOf(p.units.map((u) => u.name));
  if (dupUnits.length) errors.push({ code: 'duplicate_unit_name', names: dupUnits });

  // REPORTS-P1-C1：交付明細制或含任何交付／送審證據的來源，這一版不支援複製（不剝除後偽裝成舊制）。
  // 來源必須帶著 deliveryMode 與 _count 標記（由相同版本的 GET /api/cases 匯出），缺標記無法判定即拒絕。
  const unmarked = [], recordsCases = [], scheduleUnmarked = [], scheduleCases = [], lifecycleUnmarked = [], lifecycleCases = [];
  for (const c of p.cases) {
    const count = c._count && typeof c._count === 'object' ? c._count : null;
    if (typeof c.deliveryMode !== 'string' || !count || !Number.isInteger(count.deliveries) || !Number.isInteger(count.deliverySubmissions)) { unmarked.push(c.id); continue; }
    const hasEvidence = c.deliveryMode !== 'legacy' || count.deliveries > 0 || count.deliverySubmissions > 0
      || c.pendingDeliverySubmissionId != null || c.deliveryModeRequestId != null
      || Array.isArray(c.deliveries) || Array.isArray(c.deliverySubmissions);
    if (hasEvidence) recordsCases.push(c.id);
    // REPORTS-P2-D1a：時程受控或含改期申請紀錄的來源同樣不支援（不剝除歷史後偽裝成舊制）；缺標記即拒絕。
    if (typeof c.scheduleMode !== 'string' || !Number.isInteger(count.scheduleRequests)) { scheduleUnmarked.push(c.id); continue; }
    if (c.scheduleMode !== 'legacy' || count.scheduleRequests > 0 || c.pendingScheduleRequestId != null || c.scheduleModeRequestId != null
      || c.scheduleBaseline != null || Array.isArray(c.scheduleRequests)) scheduleCases.push(c.id);
    // REPORTS-P2-D1b：生命週期受控或含週期／封存復工紀錄的來源同樣不支援；缺標記即拒絕。
    if (typeof c.lifecycleMode !== 'string' || !Number.isInteger(count.cycles) || !Number.isInteger(count.lifecycleRequests)) { lifecycleUnmarked.push(c.id); continue; }
    if (c.lifecycleMode !== 'legacy' || count.cycles > 0 || count.lifecycleRequests > 0 || c.currentCycleId != null || c.pendingLifecycleRequestId != null
      || c.lifecycleStatus != null || c.lifecycleModeRequestId != null || Array.isArray(c.cycles) || Array.isArray(c.lifecycleRequests)) lifecycleCases.push(c.id);
  }
  if (unmarked.length) errors.push({ code: 'delivery_markers_missing', cases: unmarked.slice(0, 50), message: '來源案件缺少交付模式標記，無法確認是否含交付明細；請以相同版本的系統重新匯出後再複製' });
  if (lifecycleUnmarked.length) errors.push({ code: 'lifecycle_markers_missing', cases: lifecycleUnmarked.slice(0, 50), message: '來源案件缺少生命週期標記，無法確認是否含工作週期或封存／復工紀錄；請以相同版本的系統重新匯出後再複製' });
  if (lifecycleCases.length) errors.push({ code: 'lifecycle_history_not_supported', cases: lifecycleCases.slice(0, 50), message: '來源含生命週期受控案件或週期／封存復工紀錄，這一版的 Demo 複製不支援；請改用合成資料驗收，或移除這些案件後再複製' });
  if (scheduleUnmarked.length) errors.push({ code: 'schedule_markers_missing', cases: scheduleUnmarked.slice(0, 50), message: '來源案件缺少時程模式標記，無法確認是否含改期申請紀錄；請以相同版本的系統重新匯出後再複製' });
  if (scheduleCases.length) errors.push({ code: 'schedule_history_not_supported', cases: scheduleCases.slice(0, 50), message: '來源含時程受控案件或改期申請紀錄，這一版的 Demo 複製不支援；請改用合成資料驗收，或移除這些案件後再複製' });
  if (recordsCases.length) errors.push({ code: 'delivery_records_not_supported', cases: recordsCases.slice(0, 50), message: '來源含交付明細制案件或交付／送審紀錄，這一版的 Demo 複製不支援；請改用合成資料驗收，或移除這些案件後再複製' });

  // 人員映射：alias email 命中 → 沿用；同名但 email 非 alias → 拒絕；否則新建
  const existing = await db.staff.findMany({ select: { id: true, name: true, email: true } });
  const byEmail = new Map(existing.map((s) => [s.email, s]));
  const byName = new Map(existing.map((s) => [s.name, s]));
  const staffMap = new Map(); // sourceId → demoId（新建者暫為 null）
  const staffToCreate = [], staffReused = [], staffConflicts = [];
  for (const s of p.staff) {
    const alias = aliasEmail(s.id);
    const hitAlias = byEmail.get(alias);
    if (hitAlias) { staffMap.set(s.id, hitAlias.id); staffReused.push({ sourceId: s.id, name: s.name, demoId: hitAlias.id }); continue; }
    const hitName = byName.get(s.name);
    if (hitName) { staffConflicts.push({ sourceId: s.id, name: s.name, existingId: hitName.id, existingEmail: hitName.email }); continue; }
    staffMap.set(s.id, null); staffToCreate.push(s);
  }
  if (staffConflicts.length) errors.push({ code: 'staff_name_conflict', message: '既有名冊有同名但非資料用別名的帳號，不改既有帳號', conflicts: staffConflicts });

  // 案件：既有案號跳過；每筆的 designer/createdBy/collaborators/items 必須都能映射
  const existingCaseIds = new Set((await db.case.findMany({ select: { id: true } })).map((c) => c.id));
  const skippedExisting = [], toImport = [], missingRefs = [];
  const seen = new Set();
  for (const c of p.cases) {
    if (seen.has(c.id)) { errors.push({ code: 'duplicate_case_id_in_payload', id: c.id }); continue; }
    seen.add(c.id);
    if (existingCaseIds.has(c.id)) { skippedExisting.push(c.id); continue; }
    const refs = [];
    const designer = c.designerId ?? c.designer?.id;
    if (!sourceIds.has(designer)) refs.push({ field: 'designerId', sourceId: designer });
    const creator = c.createdById ?? c.createdBy?.id ?? null;
    if (creator !== null && !sourceIds.has(creator)) refs.push({ field: 'createdById', sourceId: creator });
    for (const col of c.collaborators || []) if (!sourceIds.has(col.id)) refs.push({ field: 'collaborators', sourceId: col.id });
    if (Array.isArray(c.items)) c.items.forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      for (const k of ITEM_STAFF_ID_KEYS) if (typeof it[k] === 'number' && !sourceIds.has(it[k])) refs.push({ field: `items[${i}].${k}`, sourceId: it[k] });
    });
    if (refs.length) { missingRefs.push({ caseId: c.id, refs }); continue; }
    toImport.push({ c, designer, creator });
  }
  if (missingRefs.length) errors.push({ code: 'missing_staff_refs', message: '案件引用了不在 staff 清單中的人員，整批不寫入', cases: missingRefs });

  // 字典：依 name upsert；列出會被更新的既有筆
  const hotelsNow = new Map((await db.hotel.findMany()).map((h) => [h.name, h]));
  const unitsNow = new Map((await db.requestUnit.findMany()).map((u) => [u.name, u]));
  const diff = (now, incoming, keys) => {
    const changed = {}; for (const k of keys) if (incoming[k] !== undefined && incoming[k] !== now[k]) changed[k] = { from: now[k], to: incoming[k] };
    return Object.keys(changed).length ? changed : null;
  };
  const hotelsCreate = [], hotelsUpdate = [];
  for (const h of p.hotels) { const now = hotelsNow.get(h.name); if (!now) hotelsCreate.push(h.name); else { const d = diff(now, h, ['region', 'sortOrder', 'active']); if (d) hotelsUpdate.push({ name: h.name, changes: d }); } }
  const unitsCreate = [], unitsUpdate = [];
  for (const u of p.units) { const now = unitsNow.get(u.name); if (!now) unitsCreate.push(u.name); else { const d = diff(now, u, ['sortOrder', 'active']); if (d) unitsUpdate.push({ name: u.name, changes: d }); } }

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      staff: { incoming: p.staff.length, create: staffToCreate.length, reuse: staffReused.length, conflict: staffConflicts.length },
      hotels: { incoming: p.hotels.length, create: hotelsCreate.length, update: hotelsUpdate.length },
      units: { incoming: p.units.length, create: unitsCreate.length, update: unitsUpdate.length },
      cases: { incoming: p.cases.length, import: toImport.length, skippedExisting: skippedExisting.length, missingRefs: missingRefs.length },
    },
    staffToCreate: staffToCreate.map((s) => ({ sourceId: s.id, name: s.name, aliasEmail: aliasEmail(s.id) })),
    staffReused, staffConflicts,
    hotelsCreate, hotelsUpdate, unitsCreate, unitsUpdate,
    skippedExisting, missingRefs,
    // 內部用
    _plan: { staffMap, staffToCreate, toImport },
  };
}

function parseBody(req, res) {
  const bad = findForbiddenKey(req.body);
  if (bad) { res.status(400).json({ error: 'forbidden_field', path: bad, message: '輸入含密碼／token 類欄位，整筆拒絕' }); return null; }
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 20) }); return null; }
  return parsed.data;
}

// ── POST /preview：完全唯讀 ──
router.post('/preview', async (req, res, next) => {
  try {
    const p = parseBody(req, res); if (!p) return;
    const a = await analyze(p);
    const { _plan, ...report } = a;
    res.json({ ...report, digest: payloadDigest(p), confirmPhrase: CONFIRM_PHRASE });
  } catch (e) { next(e); }
});

// ── POST /import：單一交易，先驗證再寫 ──
router.post('/import', async (req, res, next) => {
  try {
    const { confirm, digest, ...rest } = req.body || {};
    if (confirm !== CONFIRM_PHRASE) return res.status(400).json({ error: 'confirm_required', message: `confirm 必須為 "${CONFIRM_PHRASE}"` });
    req.body = rest;
    const p = parseBody(req, res); if (!p) return;
    const actual = payloadDigest(p);
    if (typeof digest !== 'string' || digest !== actual) {
      return res.status(409).json({ error: 'digest_mismatch', message: '資料與 preview 時不一致，請重新 preview', expected: actual });
    }

    const result = await prisma.$transaction(async (tx) => {
      const a = await analyze(p, tx);                      // 交易內重新分析，避免 preview 後資料已變
      if (!a.ok) { const e = new Error('precheck_failed'); e.code = 'PRECHECK'; e.report = a; throw e; }
      const { staffMap, staffToCreate, toImport } = a._plan;

      // 1) 人員：不可登入的資料用名冊
      for (const s of staffToCreate) {
        const created = await tx.staff.create({ data: {
          name: s.name, email: aliasEmail(s.id),
          password: await bcrypt.hash(unusablePassword(), 12),   // 與 staff.js / auth.js 一致
          role: 'member', active: s.active !== false,
          joined: toDate(s.joined) || new Date(), departedOn: toDate(s.departedOn),
          seniority: s.seniority, roleTitle: s.roleTitle || '設計師', color: s.color || null,
          pendingActivation: true, activationTokenHash: null, activationExpires: null,
          resetTokenHash: null, resetExpires: null, sessionVersion: 0, activatedAt: null,
        }, select: { id: true } });
        staffMap.set(s.id, created.id);
      }
      const mapId = (sid) => { const v = staffMap.get(sid); if (!v) throw Object.assign(new Error(`unmapped staff ${sid}`), { code: 'PRECHECK' }); return v; };

      // 2) 字典 upsert（依 name）
      for (const h of p.hotels) await tx.hotel.upsert({ where: { name: h.name }, create: { name: h.name, region: h.region, sortOrder: h.sortOrder ?? 0, active: h.active ?? true }, update: { region: h.region, ...(h.sortOrder !== undefined && { sortOrder: h.sortOrder }), ...(h.active !== undefined && { active: h.active }) } });
      for (const u of p.units) await tx.requestUnit.upsert({ where: { name: u.name }, create: { name: u.name, sortOrder: u.sortOrder ?? 0, active: u.active ?? true }, update: { ...(u.sortOrder !== undefined && { sortOrder: u.sortOrder }), ...(u.active !== undefined && { active: u.active }) } });

      // 3) 案件：白名單欄位 + 外鍵映射 + items 內 staff id 映射；logs 原樣
      let imported = 0;
      for (const { c, designer, creator } of toImport) {
        const data = {};
        for (const k of CASE_FIELDS) {
          if (c[k] === undefined) continue;
          if (JSON_FIELDS.has(k)) { data[k] = c[k] === null ? Prisma.DbNull : c[k]; continue; }
          data[k] = DATE_FIELDS.has(k) ? toDate(c[k]) : c[k];
        }
        if (Array.isArray(data.items)) data.items = data.items.map((it) => {
          if (!it || typeof it !== 'object') return it;
          const o = { ...it }; for (const k of ITEM_STAFF_ID_KEYS) if (typeof o[k] === 'number') o[k] = mapId(o[k]); return o;
        });
        for (const req of ['openDate', 'dispatchDate', 'goLiveDate']) if (!data[req]) throw Object.assign(new Error(`${c.id} missing ${req}`), { code: 'PRECHECK' });
        data.designer = { connect: { id: mapId(designer) } };
        if (creator !== null) data.createdBy = { connect: { id: mapId(creator) } };
        const cols = [...new Set((c.collaborators || []).map((x) => mapId(x.id)))].filter((id) => id !== data.designer.connect.id);
        if (cols.length) data.collaborators = { connect: cols.map((id) => ({ id })) };
        await tx.case.create({ data });
        imported++;
      }
      return { staffCreated: staffToCreate.length, staffReused: a.staffReused.length, hotels: p.hotels.length, units: p.units.length, casesImported: imported, skippedExisting: a.skippedExisting.length };
    }, { timeout: 120000 });

    res.json({ ok: true, ...result, digest: actual });
  } catch (e) {
    if (e.code === 'PRECHECK') { const { _plan, ...report } = e.report || {}; return res.status(409).json({ error: 'precheck_failed', message: e.message, ...report }); }
    if (e.code === 'P2002') return res.status(409).json({ error: 'unique_conflict', target: e.meta?.target, message: '唯一鍵衝突，整批已 rollback' });
    return next(e);
  }
});

export default router;
