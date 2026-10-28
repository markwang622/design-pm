import { safeRouter, intIdParam } from '../lib/safeRouter.js';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin, validatePasswordStrength } from '../middleware/auth.js';
import { workloadScores, workloadForAll, pickSuccessorFromRanking } from '../services/workload.js';
import { notify, tplStaffAdd, tplDeparture } from '../services/notify.js';
import { generateActivationToken, unusablePassword, activationUrl, ACTIVATION_TTL_DAYS } from '../lib/activation.js';

const router = safeRouter(); // v9.6: async 錯誤一律交給 error middleware
router.param('id', intIdParam); // v9.6: :id 統一驗正整數，不合法回 400 不碰 DB
router.use(requireAuth);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(s + 'T00:00:00Z'));

// v4.8: 個人代表色固定 palette key（前後端一致）
const STAFF_COLOR_KEYS = new Set([
  'teal', 'sea', 'lavender', 'copper', 'rose', 'mustard',
  'forest', 'indigo', 'brick', 'olive', 'slate', 'plum',
]);
const DEPARTURE_TERMINAL = ['done', 'closed', 'cancelled'];

// Every operation that can remove an eligible administrator uses a Serializable
// transaction, so two simultaneous removals cannot both pass this invariant.
async function requireAnotherLoginAdmin(tx, target) {
  if (!target?.active || target.pendingActivation || target.role !== 'admin') return;
  const others = await tx.staff.findMany({
    where: { id: { not: target.id }, active: true, pendingActivation: false, role: 'admin' },
    select: { id: true },
  });
  if (!others.length) throw Object.assign(new Error('last_admin'), {
    lastAdmin: true,
    message: '至少須保留一位已啟用且可登入的管理員；請先指定另一位管理員，再進行離職、刪除或降權',
  });
}
function sendLastAdminError(res, error) {
  if (!error.lastAdmin) return false;
  res.status(409).json({ error: 'last_admin', message: error.message });
  return true;
}

const colorSchema = z.string().refine((v) => STAFF_COLOR_KEYS.has(v), {
  message: 'invalid_color (must be one of palette keys)',
});

// ─── GET /api/staff — list with workload scores ──────────
router.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  const staff = await prisma.staff.findMany({
    where: includeInactive ? {} : { active: true },
    select: {
      id: true, name: true, email: true, active: true, joined: true, departedOn: true,
      seniority: true, roleTitle: true, role: true, color: true, // v4.8
      pendingActivation: true, activatedAt: true, activationExpires: true, // v7.3
    },
    orderBy: [{ active: 'desc' }, { id: 'asc' }],
  });
  const scores = await workloadScores(staff.map(s => s.id));
  const enriched = staff.map(s => ({ ...s, workload: scores.get(s.id) ?? 0 }));
  res.json(enriched);
});

// ─── GET /api/staff/workload — all active members sorted ─
router.get('/workload', async (req, res) => {
  const rows = await workloadForAll();
  res.json(rows);
});

// ─── POST /api/staff — create (admin) ────────────────────
const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8).optional(),
  joined: dateStr,
  seniority: z.enum(['senior', 'mid', 'junior']),
  roleTitle: z.string().optional(),
  role: z.enum(['admin', 'member', 'observer']).default('member'),
  color: colorSchema.optional(), // v4.8
});

router.post('/', requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const body = parsed.data;

  // v3.6 (#22): if admin supplies a password, enforce strength
  if (body.password) {
    const strengthErr = validatePasswordStrength(body.password);
    if (strengthErr) {
      return res.status(422).json({ error: 'weak_password', message: strengthErr });
    }
  }

  // v7.3: 預設走「邀請啟用」——管理員只指派 Email，密碼由本人首次登入時自訂。
  // 舊行為（管理員直接指定密碼）保留，供特殊情況使用。
  const useInvite = !body.password;
  let invite = null;
  let hash;
  if (useInvite) {
    invite = generateActivationToken();
    hash = await bcrypt.hash(unusablePassword(), 12); // 啟用前無任何密碼可登入
  } else {
    hash = await bcrypt.hash(body.password, 12);
  }

  try {
    const created = await prisma.staff.create({
      data: {
        name: body.name,
        email: body.email,
        password: hash,
        joined: body.joined,
        seniority: body.seniority,
        roleTitle: body.roleTitle || '設計師',
        role: body.role,
        color: body.color || null, // v4.8
        pendingActivation: useInvite,
        activationTokenHash: invite ? invite.hash : null,
        activationExpires: invite ? invite.expires : null,
      },
    });

    // v7.5: 只通知管理員（新人本人另外收啟用信）。
    // 原本是廣播給全體在職成員 —— 在 SMTP 未設定時只是站內通知無傷大雅，但
    // 一旦開始真的寄信，每加一位新人就會寄給全部門，而且信寄出去收不回來。
    const admins = await prisma.staff.findMany({
      where: { active: true, role: 'admin', NOT: { id: created.id } },
      select: { id: true },
    });
    const tpl = tplStaffAdd({ newStaff: created });
    await Promise.all(
      admins.map((o) => notify({ type: 'staffAdd', recipientId: o.id, ...tpl }))
    );

    // v7.3: 啟用連結明碼只在這裡回傳一次；DB 只留 hash，之後任何人都讀不到。
    let inviteUrl = null;
    if (invite) {
      inviteUrl = activationUrl(req, invite.token);
      // SMTP 若已設定就順便寄出；沒設定時 notify 會 dry-run，管理員仍可複製連結。
      notify({
        type: 'staffAdd', recipientId: created.id,
        subject: `【藝術設計部】請設定你的登入密碼`,
        body: `${created.name} 你好：\n\n你的帳號已建立（${created.email}）。\n請在 ${ACTIVATION_TTL_DAYS} 天內開啟以下連結設定密碼並啟用帳號：\n\n${inviteUrl}\n\n此連結僅能使用一次。若已過期，請聯絡管理員重新產生。`,
      }).catch((e) => console.warn('[staff] invite mail failed:', e.message));
    }

    res.status(201).json({
      ...created,
      password: undefined, activationTokenHash: undefined, resetTokenHash: undefined, resetExpires: undefined, sessionVersion: undefined,
      inviteUrl,
      inviteExpires: invite ? invite.expires : undefined,
    });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'duplicate', field: e.meta?.target });
    }
    throw e;
  }
});

// ─── POST /api/staff/:id/reinvite — 重新產生啟用連結 (v7.3) ──
// 用於連結過期、寄丟、或同仁把連結弄不見。舊連結立即失效。
router.post('/:id/reinvite', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const staff = await prisma.staff.findUnique({ where: { id } });
  if (!staff) return res.status(404).json({ error: 'not_found' });
  if (!staff.pendingActivation) {
    return res.status(409).json({ error: 'already_activated', message: '此帳號已啟用，如需重設密碼請用「重設密碼」功能。' });
  }
  const invite = generateActivationToken();
  const replaced = await prisma.staff.updateMany({
    where: { id, active: true, pendingActivation: true },
    data: {
      activationTokenHash: invite.hash,
      activationExpires: invite.expires,
      password: await bcrypt.hash(unusablePassword(), 12), // 一併換掉佔位密碼
    },
  });
  if (replaced.count !== 1) return res.status(409).json({ error: 'invitation_changed', message: '帳號狀態已變更，請重新整理' });
  const inviteUrl = activationUrl(req, invite.token);
  notify({
    type: 'staffAdd', recipientId: id,
    subject: '【藝術設計部】請設定你的登入密碼（重新寄送）',
    body: `${staff.name} 你好：\n\n請在 ${ACTIVATION_TTL_DAYS} 天內開啟以下連結設定密碼：\n\n${inviteUrl}\n\n此連結僅能使用一次，先前的連結已失效。`,
  }).catch(() => {});
  res.json({ inviteUrl, inviteExpires: invite.expires });
});

// ─── PATCH /api/staff/:id — update (admin or self, v3.4 expanded) ─
const updateSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  seniority: z.enum(['senior', 'mid', 'junior']).optional(),
  roleTitle: z.string().optional(),
  role: z.enum(['admin', 'member', 'observer']).optional(),
  // v3.4: admin-only password reset for OTHER users
  resetPassword: z.string().min(8).max(200).optional(),
  // v4.8: 個人色 palette key（或 null 清空）
  color: z.union([colorSchema, z.null()]).optional(),
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });

  const isSelf = req.user.id === id;
  const isAdmin = req.user.role === 'admin';

  if (!isSelf && !isAdmin) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const data = { ...parsed.data };
  // non-admin cannot change role
  if (data.role && !isAdmin) delete data.role;
  // Password reset: only admin, only for OTHER users (self uses /change-password with current pw)
  if (data.resetPassword !== undefined) {
    if (!isAdmin || isSelf) {
      return res.status(403).json({
        error: 'password_reset_forbidden',
        message: '管理員只能重設他人的密碼；自己的密碼請走「修改密碼」並輸入舊密碼',
      });
    }
    // v3.6 (#22): enforce strength on admin-reset too
    const strengthErr = validatePasswordStrength(data.resetPassword);
    if (strengthErr) {
      return res.status(422).json({ error: 'weak_password', message: strengthErr });
    }
    data.password = await bcrypt.hash(data.resetPassword, 12);
    data.sessionVersion = { increment: 1 };
    data.resetTokenHash = null;
    data.resetExpires = null;
    delete data.resetPassword;
  }

  try {
    const updated = data.name === undefined && data.role === undefined
      ? await prisma.staff.update({ where: { id }, data })
      : await prisma.$transaction(async (tx) => {
        const current = await tx.staff.findUnique({ where: { id } });
        if (!current) throw Object.assign(new Error('not_found'), { code: 'P2025' });
        if (data.role !== undefined && data.role !== 'admin') await requireAnotherLoginAdmin(tx, current);
        const staff = await tx.staff.update({ where: { id }, data });
        if (data.name === undefined || current.name === staff.name) return staff;

        // Old subitems identified people by display name. Preserve that identity
        // durably before the old name disappears; labels on ID assignments also
        // follow the rename. Historical logs and all unrelated JSON stay intact.
        const cases = await tx.case.findMany({ select: { id: true, items: true, updatedAt: true, contentVersion: true } });
        for (const c of cases) {
          if (!Array.isArray(c.items)) continue;
          let changed = false;
          const items = c.items.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
            const assignedId = typeof item.assigneeId === 'number'
              || (typeof item.assigneeId === 'string' && item.assigneeId.trim() !== '')
              ? Number(item.assigneeId) : null;
            const legacyMatch = item.assigneeId == null && current.name && item.owner === current.name;
            if (assignedId !== id && !legacyMatch) return item;
            if (item.assigneeId === id && item.owner === staff.name) return item;
            changed = true;
            return { ...item, assigneeId: id, owner: staff.name };
          });
          if (!changed) continue;
          const previous = new Date(c.updatedAt).getTime();
          if (!Number.isFinite(previous) || !Number.isSafeInteger(c.contentVersion) || c.contentVersion < 0) {
            throw Object.assign(new Error('staff_rename_conflict'), { code: 'STAFF_RENAME_CONFLICT' });
          }
          const claimed = await tx.case.updateMany({
            where: { id: c.id, updatedAt: c.updatedAt, contentVersion: c.contentVersion },
            data: { items, contentVersion: { increment: 1 }, updatedAt: new Date(Math.max(Date.now(), previous + 1)) },
          });
          if (claimed.count !== 1) throw Object.assign(new Error('staff_rename_conflict'), { code: 'STAFF_RENAME_CONFLICT' });
        }
        return staff;
      }, { isolationLevel: 'Serializable' });
    res.json({ ...updated, password: undefined, activationTokenHash: undefined, resetTokenHash: undefined, resetExpires: undefined, sessionVersion: undefined });
  } catch (e) {
    if (sendLastAdminError(res, e)) return;
    if (e.code === 'P2034' && data.name === undefined) {
      return res.status(409).json({ error: 'staff_conflict', message: '人員狀態已被其他操作更新，本次操作未完成，請重新整理後再試' });
    }
    if (e.code === 'STAFF_RENAME_CONFLICT' || e.code === 'P2034') {
      return res.status(409).json({ error: 'staff_rename_conflict', message: '人員或子案件已被其他操作更新，姓名尚未變更，請重新整理後再試' });
    }
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'duplicate', field: e.meta?.target });
    }
    if (e.code === 'P2025') {
      return res.status(404).json({ error: 'not_found' });
    }
    throw e;
  }
});

// ─── GET /api/staff/:id/departure-preview — pre-compute ──
router.get('/:id/departure-preview', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const leaver = await prisma.staff.findUnique({ where: { id } });
  if (!leaver) return res.status(404).json({ error: 'not_found' });

  const [ownedDone, ownedOpen, collabOn] = await Promise.all([
    prisma.case.findMany({ where: { designerId: id, status: { in: DEPARTURE_TERMINAL }, archived: false } }),
    prisma.case.findMany({
      where: { designerId: id, status: { notIn: DEPARTURE_TERMINAL }, archived: false },
      include: { collaborators: { select: { id: true, name: true } } },
    }),
    prisma.case.findMany({
      where: { archived: false, status: { notIn: DEPARTURE_TERMINAL }, collaborators: { some: { id } }, NOT: { designerId: id } },
      select: { id: true, title: true, designerId: true },
    }),
  ]);

  // The same current workload ranking applies to every open case. Reuse its
  // two tie-break outcomes; suggestions do not reserve or project new work.
  const ranked = ownedOpen.length ? await workloadForAll({ excludeId: id, assignableOnly: true }) : [];
  const standardSuggestion = pickSuccessorFromRanking(ranked, 'A') ?? null;
  const seniorSuggestion = pickSuccessorFromRanking(ranked, 'SS') ?? null;

  res.json({
    leaver: { id: leaver.id, name: leaver.name, joined: leaver.joined, seniority: leaver.seniority },
    toArchive: ownedDone.map((c) => ({ id: c.id, title: c.title })),
    toTransfer: ownedOpen.map((c) => ({
      id: c.id,
      title: c.title,
      level: c.level,
      status: c.status,
      goLiveDate: c.goLiveDate,
      collaborators: c.collaborators,
      suggestion: ['SS', 'S'].includes(c.level) ? seniorSuggestion : standardSuggestion,
    })),
    toRemoveCollab: collabOn,
  });
});

// ─── POST /api/staff/:id/departure — execute ─────────────
const departureSchema = z.object({
  successors: z.record(z.string(), z.number().int()), // caseId → newDesignerId
});

router.post('/:id/departure', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = departureSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const reject = (status, error, extra = {}) => {
        throw Object.assign(new Error(error), { departureStatus: status, detail: { error, ...extra } });
      };
      const leaver = await tx.staff.findUnique({ where: { id } });
      if (!leaver) reject(404, 'not_found');
      if (!leaver.active) reject(400, 'already_departed');
      await requireAnotherLoginAdmin(tx, leaver);
      const [ownedDone, ownedOpen, collabOn] = await Promise.all([
        tx.case.findMany({ where: { designerId: id, status: { in: DEPARTURE_TERMINAL }, archived: false } }),
        tx.case.findMany({ where: { designerId: id, status: { notIn: DEPARTURE_TERMINAL }, archived: false } }),
        tx.case.findMany({
          where: { archived: false, status: { notIn: DEPARTURE_TERMINAL }, collaborators: { some: { id } }, NOT: { designerId: id } },
          select: { id: true },
        }),
      ]);

      // REPORTS-P2-D1b: a pending seal/resume request is decided against a fixed assignment snapshot; the departure
      // must wait until it is approved, rejected or withdrawn (explicit order, nothing half-written). Sealed cases are
      // archived and stay untouched; completed/cancelled lifecycle-managed cases are read-only and are not re-filed.
      const pendingLifecycle = [...ownedDone, ...ownedOpen].filter(c => c.pendingLifecycleRequestId).map(c => c.id);
      if (collabOn.length) {
        const rows = await tx.case.findMany({ where: { id: { in: collabOn.map(c => c.id) }, NOT: { pendingLifecycleRequestId: null } }, select: { id: true } });
        pendingLifecycle.push(...rows.map(r => r.id));
      }
      if (pendingLifecycle.length) reject(409, 'lifecycle_request_pending', { cases: pendingLifecycle, message: '這些案件有待主管決議的封存／復工申請，請先處理後再辦理離職移轉' });
      // Validate the full plan before the first write, using the same snapshot
      // as the transfers and departure. No case can be assigned to a disabled,
      // unactivated, read-only account or the departing person themselves.
      const successors = new Map();
      for (const c of ownedOpen) {
        const toId = parsed.data.successors[c.id];
        if (toId === undefined) reject(400, 'missing_successor', { caseId: c.id, message: `案件 ${c.id} 尚未指定繼承人` });
        let successor = successors.get(toId);
        if (!successor) {
          successor = await tx.staff.findUnique({ where: { id: toId } });
          if (toId === id || !successor?.active || successor.pendingActivation || !['admin', 'member'].includes(successor.role)) {
            reject(422, 'invalid_successor', { caseId: c.id, successorId: toId });
          }
          successors.set(toId, successor);
        }
      }

      const transferred = [], archived = [], removedCollab = [];
      for (const c of ownedDone) {
        if (c.lifecycleMode === 'managed') continue;
        await tx.case.update({ where: { id: c.id }, data: { archived: true } });
        archived.push(c.id);
      }
      for (const c of ownedOpen) {
        const toId = parsed.data.successors[c.id];
        const toStaff = successors.get(toId);
        await tx.case.update({
          where: { id: c.id },
          data: { designer: { connect: { id: toId } }, collaborators: { disconnect: { id: toId } } },
        });
        await tx.transferLog.create({ data: {
          caseId: c.id, fromName: leaver.name, toName: toStaff.name,
          reason: '離職移轉', operator: req.user.name,
        } });
        transferred.push({ caseId: c.id, toName: toStaff.name });
      }
      // Completed, cancelled and archived participation is reporting history.
      // Only current work assignments are removed during departure.
      for (const c of collabOn) {
        await tx.case.update({ where: { id: c.id }, data: { collaborators: { disconnect: { id } } } });
        removedCollab.push(c.id);
      }
      await tx.staff.update({ where: { id }, data: { active: false, departedOn: new Date() } });
      return { leaver, transferred, archived, removedCollab };
    }, { isolationLevel: 'Serializable' });
  } catch (e) {
    if (sendLastAdminError(res, e)) return;
    if (e.departureStatus) return res.status(e.departureStatus).json(e.detail);
    if (e.code === 'P2034') return res.status(409).json({ error: 'write_conflict', message: '人員或案件已變更，請重新整理後再試' });
    throw e;
  }
  const { leaver, transferred, archived, removedCollab } = result;

  // Notifications (outside transaction)
  try {
    const tpl = tplDeparture({ leaver, transferred, archived, removedCollab });
    const admins = await prisma.staff.findMany({ where: { role: 'admin', active: true }, select: { id: true } });
    const recipientIds = new Set([
      ...admins.map((a) => a.id),
      ...(await Promise.all(
        transferred.map(async (t) => {
          const s = await prisma.staff.findUnique({ where: { name: t.toName }, select: { id: true } });
          return s?.id;
        })
      )).filter(Boolean),
    ]);
    for (const rid of recipientIds) {
      await notify({ type: 'departure', recipientId: rid, ...tpl });
    }
  } catch (e) {
    console.warn('[departure] notification failed:', e.message);
  }

  res.json({ ok: true, transferred, archived, removedCollab });
});

// ─── DELETE /api/staff/:id — hard delete (admin, rare) ──
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await prisma.$transaction(async tx => {
      const target = await tx.staff.findUnique({ where: { id } });
      if (!target) return { status: 404, error: 'not_found' };
      await requireAnotherLoginAdmin(tx, target);
      if (target.active) return { status: 400, error: 'active_staff_cannot_delete' };
      await tx.staff.delete({ where: { id } });
      return null;
    }, { isolationLevel: 'Serializable' });
    if (result) return res.status(result.status).json({ error: result.error });
  } catch (e) {
    if (sendLastAdminError(res, e)) return;
    if (e.code === 'P2034') return res.status(409).json({ error: 'staff_conflict', message: '人員狀態已被其他操作更新，請重新整理後再試' });
    throw e;
  }
  res.json({ ok: true });
});

export default router;
