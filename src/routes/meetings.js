// ─────────────────────────────────────────────────────────────
// Meeting routes (v6.0) — 會議排程。
// 任何登入者可建立/瀏覽；編輯/刪除限建立者、主持人或 admin。
// 時間模型：date(@db.Date) + startTime/endTime("HH:MM" 本地牆鐘)。
// 與會者僅內部同仁（MeetingAttendee join，含出席回覆狀態）。
// 建立時通知與會者與主持人，並回傳衝突偵測結果（不阻擋）。
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { notify } from '../services/notify.js';
import crypto from 'node:crypto';

const router = Router();
router.use(requireAuth);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(s + 'T00:00:00Z'));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const MEETING_TYPES = ['internal', 'proposal', 'review', 'crossdept', 'other'];
const MEETING_STATUS = ['scheduled', 'confirmed', 'cancelled', 'done'];
const actionItem = z.object({ text: z.string().max(300), owner: z.string().max(60).default(''), done: z.boolean().default(false) });

const createSchema = z.object({
  title: z.string().min(1).max(200),
  agenda: z.string().max(2000).default(''),
  date: dateStr,
  startTime: hhmm,
  endTime: hhmm,
  location: z.string().max(300).default(''),
  type: z.enum(MEETING_TYPES).default('internal'),
  status: z.enum(MEETING_STATUS).default('scheduled'),
  note: z.string().max(1000).default(''),
  minutes: z.string().max(5000).default(''),
  actionItems: z.array(actionItem).default([]),
  remindMinutes: z.number().int().min(0).max(1440).default(0),
  hostId: z.number().int().nullable().optional(),
  caseId: z.string().max(40).nullable().optional(),
  attendeeIds: z.array(z.number().int()).default([]),
  recurrence: z.object({
    freq: z.enum(['none', 'weekly', 'biweekly', 'monthly']).default('none'),
    count: z.number().int().min(1).max(52).default(1),
  }).optional(),
});

const updateSchema = createSchema.partial();
const RECUR_LABEL = { weekly: '每週', biweekly: '隔週', monthly: '每月' };

// 依重複規則展開日期（回傳 Date 陣列；包含起始日）
function expandDates(start, freq, count) {
  if (!freq || freq === 'none' || count <= 1) return [new Date(start)];
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + i * 7);
    else if (freq === 'biweekly') d.setUTCDate(d.getUTCDate() + i * 14);
    else if (freq === 'monthly') d.setUTCMonth(d.getUTCMonth() + i);
    out.push(d);
  }
  return out;
}

const include = {
  host: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  case: { select: { id: true, title: true } },
  attendees: { select: { id: true, staffId: true, response: true, required: true, staff: { select: { id: true, name: true } } } },
};

// ── 衝突偵測 ──────────────────────────────────────────────
// 對某場會議的日期/時段 + 參與者（主持人 + 與會者），找出：
//   1. 與會者當天請假 / 出差（整天事件）
//   2. 與會者同一天有另一場時段重疊的會議
// 回傳 [{ type, staffName, detail }]，不阻擋建立。
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; } // "HH:MM" 字典序即時間序
async function detectConflicts({ date, startTime, endTime, staffIds, excludeMeetingId }) {
  if (!staffIds.length) return [];
  const out = [];
  const nameById = {};
  const staff = await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } });
  staff.forEach((s) => { nameById[s.id] = s.name; });

  const [vacs, trips, meets] = await Promise.all([
    prisma.vacation.findMany({ where: { staffId: { in: staffIds }, startDate: { lte: date }, endDate: { gte: date } }, include: { staff: { select: { name: true } } } }),
    prisma.businessTrip.findMany({ where: { staffId: { in: staffIds }, startDate: { lte: date }, endDate: { gte: date } }, include: { staff: { select: { name: true } } } }),
    prisma.meeting.findMany({
      where: { date, status: { not: 'cancelled' }, id: excludeMeetingId ? { not: excludeMeetingId } : undefined, OR: [{ hostId: { in: staffIds } }, { attendees: { some: { staffId: { in: staffIds } } } }] },
      include: { attendees: { select: { staffId: true } } },
    }),
  ]);

  vacs.forEach((v) => out.push({ type: 'vacation', staffName: v.staff?.name || '', detail: '當天請假' }));
  trips.forEach((t) => out.push({ type: 'trip', staffName: t.staff?.name || '', detail: `當天出差 ${t.hotel || ''}`.trim() }));
  meets.forEach((m) => {
    if (!overlaps(startTime, endTime, m.startTime, m.endTime)) return;
    const involved = new Set([m.hostId, ...m.attendees.map((a) => a.staffId)].filter(Boolean));
    staffIds.forEach((sid) => {
      if (involved.has(sid)) out.push({ type: 'meeting', staffName: nameById[sid] || '', detail: `時段重疊：${m.title}（${m.startTime}–${m.endTime}）` });
    });
  });
  return out;
}

router.get('/', async (req, res) => {
  const where = {};
  if (req.query.from || req.query.to) {
    where.AND = [];
    if (req.query.from) where.AND.push({ date: { gte: new Date(req.query.from) } });
    if (req.query.to) where.AND.push({ date: { lte: new Date(req.query.to) } });
  }
  if (req.query.caseId) where.caseId = String(req.query.caseId);
  const rows = await prisma.meeting.findMany({ where, include, orderBy: [{ date: 'desc' }, { startTime: 'asc' }] });
  res.json(rows);
});

router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const b = parsed.data;
  if (b.endTime <= b.startTime) return res.status(422).json({ error: 'invalid_range', message: '結束時間必須晚於開始時間' });

  const attendeeIds = [...new Set(b.attendeeIds)];
  const freq = b.recurrence?.freq || 'none';
  const count = b.recurrence?.count || 1;
  const dates = expandDates(b.date, freq, count);
  const seriesId = dates.length > 1 ? crypto.randomUUID() : null;

  const baseData = (d) => ({
    title: b.title, agenda: b.agenda, date: d, startTime: b.startTime, endTime: b.endTime,
    location: b.location, type: b.type, status: b.status, note: b.note,
    minutes: b.minutes, actionItems: b.actionItems, remindMinutes: b.remindMinutes,
    seriesId, hostId: b.hostId ?? null, caseId: b.caseId || null, createdById: req.user?.id ?? null,
    attendees: { create: attendeeIds.map((sid) => ({ staffId: sid, response: sid === b.hostId ? 'accepted' : 'pending' })) },
  });

  // 逐筆建立（系列共用 seriesId）
  const createdList = [];
  for (const d of dates) createdList.push(await prisma.meeting.create({ data: baseData(d), include }));
  const created = createdList[0];

  // 衝突偵測（彙整整個系列）
  const staffIds = [...new Set([b.hostId, ...attendeeIds].filter(Boolean))];
  const conflicts = [];
  for (const m of createdList) {
    const cf = await detectConflicts({ date: m.date, startTime: m.startTime, endTime: m.endTime, staffIds, excludeMeetingId: m.id });
    cf.forEach((c) => conflicts.push({ ...c, detail: dates.length > 1 ? `${String(m.date).slice(0, 10)} ${c.detail}` : c.detail }));
  }

  // 通知與會者 + 主持人（排除建立者本人）— 系列只通知一次
  const dateLabel = dates[0].toISOString().slice(0, 10);
  const recurNote = dates.length > 1 ? `（${RECUR_LABEL[freq]}，共 ${dates.length} 場）` : '';
  const recipients = [...new Set([b.hostId, ...attendeeIds].filter((id) => id && id !== req.user?.id))];
  for (const rid of recipients) {
    await notify({
      type: 'meetingInvite', recipientId: rid, relatedCaseId: b.caseId || null,
      subject: `【會議邀請】${b.title}${recurNote}`,
      body: `${req.user?.name || '有人'} 邀請您參加會議：\n\n主題：${b.title}${recurNote}\n時間：${dateLabel} ${b.startTime}–${b.endTime}\n地點：${b.location || '（未填）'}\n${b.agenda ? '議程：' + b.agenda + '\n' : ''}\n請至系統行事曆查看並回覆出席。`,
    }).catch((e) => console.warn('[meeting] notify failed:', e.message));
  }

  res.status(201).json({ ...created, conflicts, seriesCount: dates.length });
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.meeting.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && existing.createdById !== req.user.id && existing.hostId !== req.user.id) {
    return res.status(403).json({ error: 'forbidden', message: '只有建立者、主持人或 admin 可編輯此會議' });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const b = parsed.data;
  const startTime = b.startTime ?? existing.startTime;
  const endTime = b.endTime ?? existing.endTime;
  if (endTime <= startTime) return res.status(422).json({ error: 'invalid_range', message: '結束時間必須晚於開始時間' });

  const data = {};
  for (const k of ['title', 'agenda', 'date', 'startTime', 'endTime', 'location', 'type', 'status', 'note', 'minutes', 'actionItems', 'remindMinutes']) {
    if (b[k] !== undefined) data[k] = b[k];
  }
  // 若改了時間，重置提醒旗標，讓提醒重新計算
  if (b.startTime !== undefined || b.date !== undefined || b.remindMinutes !== undefined) data.remindedAt = null;
  if (b.hostId !== undefined) data.hostId = b.hostId ?? null;
  if (b.caseId !== undefined) data.caseId = b.caseId || null;
  // 與會者：若有提供則整批取代（保留既有回覆狀態）
  if (b.attendeeIds !== undefined) {
    const wantIds = [...new Set(b.attendeeIds)];
    const cur = await prisma.meetingAttendee.findMany({ where: { meetingId: id }, select: { staffId: true } });
    const curIds = new Set(cur.map((a) => a.staffId));
    const toAdd = wantIds.filter((x) => !curIds.has(x));
    const toRemove = [...curIds].filter((x) => !wantIds.includes(x));
    data.attendees = {
      ...(toAdd.length ? { create: toAdd.map((sid) => ({ staffId: sid, response: 'pending' })) } : {}),
      ...(toRemove.length ? { deleteMany: toRemove.map((sid) => ({ staffId: sid })) } : {}),
    };
  }
  const updated = await prisma.meeting.update({ where: { id }, data, include });

  const staffIds = [...new Set([updated.hostId, ...updated.attendees.map((a) => a.staffId)].filter(Boolean))];
  const conflicts = await detectConflicts({ date: updated.date, startTime: updated.startTime, endTime: updated.endTime, staffIds, excludeMeetingId: id });
  res.json({ ...updated, conflicts });
});

// 出席回覆：與會者回覆自己的出席狀態
router.post('/:id/respond', async (req, res) => {
  const id = Number(req.params.id);
  const response = z.enum(['accepted', 'declined', 'tentative', 'pending']).safeParse(req.body?.response);
  if (!response.success) return res.status(400).json({ error: 'invalid_response' });
  const att = await prisma.meetingAttendee.findUnique({ where: { meetingId_staffId: { meetingId: id, staffId: req.user.id } } });
  if (!att) return res.status(403).json({ error: 'not_an_attendee', message: '您不在此會議的與會者名單中' });
  await prisma.meetingAttendee.update({ where: { id: att.id }, data: { response: response.data } });
  const updated = await prisma.meeting.findUnique({ where: { id }, include });
  res.json(updated);
});

// M2: 待辦轉進度日誌 — 附到關聯案件的 logs
router.post('/:id/action-to-log', async (req, res) => {
  const id = Number(req.params.id);
  const index = Number(req.body?.index);
  const m = await prisma.meeting.findUnique({ where: { id } });
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (!m.caseId) return res.status(422).json({ error: 'no_case', message: '此會議未關聯案件，無法轉進度日誌' });
  const items = Array.isArray(m.actionItems) ? m.actionItems : [];
  const item = items[index];
  if (!item) return res.status(404).json({ error: 'no_item' });
  const c = await prisma.case.findUnique({ where: { id: m.caseId }, select: { logs: true } });
  if (!c) return res.status(404).json({ error: 'case_not_found' });
  const logs = Array.isArray(c.logs) ? c.logs : [];
  logs.push({
    date: new Date().toISOString().slice(0, 10),
    text: `[會議待辦] ${item.text}${item.owner ? '（' + item.owner + '）' : ''}`,
    author: req.user?.name || '',
    fromMeeting: m.id,
  });
  await prisma.case.update({ where: { id: m.caseId }, data: { logs } });
  res.json({ ok: true, caseId: m.caseId });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.meeting.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && existing.createdById !== req.user.id && existing.hostId !== req.user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // ?series=1 且屬於系列 → 刪除整個系列
  if (req.query.series === '1' && existing.seriesId) {
    const r = await prisma.meeting.deleteMany({ where: { seriesId: existing.seriesId } });
    return res.json({ ok: true, deleted: r.count });
  }
  await prisma.meeting.delete({ where: { id } });
  res.json({ ok: true, deleted: 1 });
});

export default router;
