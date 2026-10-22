// ─────────────────────────────────────────────────────────────
// Hotel dictionary — admin can add / rename / hide hotels.
// Frontend pulls /api/hotels at bootstrap to populate dropdowns.
// ─────────────────────────────────────────────────────────────
import { safeRouter, intIdParam } from '../lib/safeRouter.js';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

// v8.0: 館別清單的版本指紋。涵蓋 id / sortOrder / active / updatedAt，
// 因此「順序改了」「有人停用館別」「有人改名」都會讓指紋變動。
// 只比對 ID 集合不夠——兩位管理者拿到相同 ID 但不同順序時會互相靜默覆蓋。
export function hotelFingerprint(rows) {
  const s = rows.slice().sort((a, b) => a.id - b.id)
    .map((h) => `${h.id}:${h.sortOrder}:${h.active ? 1 : 0}:${new Date(h.updatedAt).getTime()}`)
    .join('|');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

const router = safeRouter(); // v9.6: async 錯誤一律交給 error middleware
router.param('id', intIdParam); // v9.6: :id 統一驗正整數，不合法回 400 不碰 DB
router.use(requireAuth);

// GET /api/hotels — everyone (members need it for case create dropdown)
router.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  const rows = await prisma.hotel.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  // v8.0: 排序編輯器需要一份開啟當下的版本快照才能偵測衝突。
  // 指紋一律以「全部館別」計算，與是否過濾 active 無關。
  if (req.query.withVersion === '1') {
    const all = includeInactive ? rows : await prisma.hotel.findMany();
    return res.json({ hotels: rows, version: hotelFingerprint(all) });
  }
  res.json(rows);
});

// ─── POST /api/hotels/reorder — 原子批次重排 (v8.0) ─────────
// 為什麼需要這支：前端若用多個互不相關的 PATCH 送出順序，任何一筆失敗都會
// 留下半套順序，而且無法偵測「別人同時新增／停用館別」造成的衝突。
// 這裡在單一 transaction 內更新，並先驗證送來的 ID 集合與資料庫完全一致。
const reorderSchema = z.object({
  // 完整館別 ID 依目標順序排列（含停用者，避免部分清單造成跨館順序混亂）
  ids: z.array(z.number().int()).min(1).max(500),
  // 開啟排序編輯器當下的版本指紋（來自 GET ?withVersion=1）
  version: z.string().min(8).max(64),
});
router.post('/reorder', requireAdmin, async (req, res, next) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const { ids, version } = parsed.data;

  // 重複 ID 直接擋下：代表前端狀態已錯亂，不可寫入
  const uniq = new Set(ids);
  if (uniq.size !== ids.length) {
    return res.status(400).json({ error: 'duplicate_ids', message: '順序清單含重複館別，請重新整理後再試。' });
  }

  try {
    // 讀取與寫入必須在同一個交易內，否則 read-then-write 之間的空窗
    // 會讓「相同 ID、不同順序」的兩次提交互相靜默覆蓋。
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.hotel.findMany();
      const currentIds = new Set(current.map((h) => h.id));
      const missing = current.filter((h) => !uniq.has(h.id)).map((h) => h.id);
      const unknown = ids.filter((id) => !currentIds.has(id));
      if (missing.length || unknown.length) {
        const e = new Error('stale_list'); e.code = 'STALE';
        e.detail = { missingIds: missing, unknownIds: unknown };
        throw e;
      }
      // 版本比對：涵蓋順序、active、更新時間，能抓到集合相同但內容已變的情況
      if (hotelFingerprint(current) !== version) {
        const e = new Error('version_conflict'); e.code = 'CONFLICT';
        throw e;
      }
      for (let i = 0; i < ids.length; i++) {
        await tx.hotel.update({ where: { id: ids[i] }, data: { sortOrder: i + 1 } });
      }
      const rows = await tx.hotel.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
      // 版本指紋必須在交易內、從同一份 rows 算出。若在交易外再查一次，
      // 另一位管理者恰好在 commit 後、查詢前寫入，就會回傳「舊 hotels + 新 version」，
      // 下一次提交又會拿著那個 version 覆蓋對方的變更。
      return { rows, version: hotelFingerprint(rows) };
    }, { isolationLevel: 'Serializable' });

    res.json({ ok: true, count: result.rows.length, hotels: result.rows, version: result.version });
  } catch (e) {
    if (e.code === 'STALE') {
      return res.status(409).json({
        error: 'stale_list',
        message: '館別清單在你編輯期間已變動（有人新增或刪除館別），請重新載入後再排序。',
        ...e.detail,
      });
    }
    if (e.code === 'CONFLICT') {
      return res.status(409).json({
        error: 'version_conflict',
        message: '有人在你編輯期間調整了館別，為避免覆蓋對方的變更，這次沒有儲存。請重新載入後再排序。',
      });
    }
    // Serializable 下的寫入競爭（Postgres 40001）同樣以 409 回報，交易已自動 rollback
    if (e.code === 'P2034' || /serializ|40001|write conflict/i.test(e.message || '')) {
      return res.status(409).json({
        error: 'write_conflict',
        message: '另一位管理者正在同時調整館別順序，這次沒有儲存。請重新載入後再試一次。',
      });
    }
    // Express 4 不會接住 async handler 裡 throw 出來的錯誤（會變成未處理的
    // promise rejection），必須交給 next() 走正規錯誤處理。
    return next(e);
  }
});

const createSchema = z.object({
  region: z.string().min(1).max(20),
  name: z.string().min(1).max(40),
  sortOrder: z.number().int().optional(),
});

router.post('/', requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try {
    // Default sortOrder: append at end
    let sortOrder = parsed.data.sortOrder;
    if (sortOrder === undefined) {
      const last = await prisma.hotel.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? 0) + 10;
    }
    const created = await prisma.hotel.create({
      data: { region: parsed.data.region, name: parsed.data.name, sortOrder },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'duplicate', message: '館別名稱已存在' });
    throw e;
  }
});

const updateSchema = z.object({
  region: z.string().min(1).max(20).optional(),
  name: z.string().min(1).max(40).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

router.patch('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  try {
    const updated = await prisma.hotel.update({ where: { id }, data: parsed.data });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'duplicate' });
    if (e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
});

// DELETE: only allowed if no cases reference this hotel; otherwise return 409.
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const hotel = await prisma.hotel.findUnique({ where: { id } });
  if (!hotel) return res.status(404).json({ error: 'not_found' });
  const usingCount = await prisma.case.count({ where: { hotel: hotel.name } });
  if (usingCount > 0) {
    return res.status(409).json({
      error: 'in_use',
      message: `仍有 ${usingCount} 件案件使用此館別，請先設為停用而非刪除`,
    });
  }
  await prisma.hotel.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
