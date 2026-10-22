import { prisma } from './db.js';

export const caseContentInclude = {
  designer: { select: { id: true, name: true, seniority: true, active: true } },
  collaborators: { select: { id: true, name: true, seniority: true, active: true } },
  createdBy: { select: { id: true, name: true } },
};

export class CaseEditError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const conflict = () => new CaseEditError(409, 'edit_conflict', '內容已更新，請重新載入後再編輯；你的變更尚未覆寫。');
export function sendCaseEditError(res, error) {
  if (!(error instanceof CaseEditError)) return false;
  res.status(error.status).json({ error: error.code, message: error.message });
  return true;
}
function assignmentWhere(user) {
  return user.role === 'admin' ? {} : { OR: [{ designerId: user.id }, { collaborators: { some: { id: user.id } } }] };
}
function checkPermission(user, row) {
  if (!row) throw new CaseEditError(404, 'not_found', '找不到案件');
  if (!user || user.role === 'observer' || (user.role !== 'admin' && row.designerId !== user.id && !row.collaborators?.some(s => s.id === user.id))) {
    throw new CaseEditError(403, 'forbidden', '只有主負責人、協作者或管理員可編輯案件內容');
  }
}
async function editableCase(id, user) {
  const row = await prisma.case.findUnique({ where: { id }, include: caseContentInclude });
  checkPermission(user, row);
  return row;
}
function stamp(row) {
  const ms = new Date(row.updatedAt).getTime();
  if (!Number.isFinite(ms)) throw new Error('Case update timestamp unavailable');
  return { previous: new Date(ms), next: new Date(Math.max(Date.now(), ms + 1)) };
}
// Old meeting exports used text/author. Keep every original field and row; add the
// canonical aliases without deleting information or running a data migration.
export function normalizeStoredLogs(logs) {
  return (Array.isArray(logs) ? logs : []).map(log => {
    if (!log || typeof log !== 'object' || Array.isArray(log)) return log;
    return { ...log,
      ...(typeof log.note !== 'string' && typeof log.text === 'string' ? { note: log.text } : {}),
      ...(typeof log.by !== 'string' && typeof log.author === 'string' ? { by: log.author } : {}),
    };
  });
}
export function taipeiLogDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export async function replaceCaseJson(id, user, field, value, expectedUpdatedAt, expectedContentVersion) {
  if (!['logs', 'items'].includes(field)) throw new Error('Unsupported case JSON field');
  const existing = await editableCase(id, user);
  const version = stamp(existing);
  if (!Number.isSafeInteger(existing.contentVersion) || existing.contentVersion < 0) throw new Error('Case content version unavailable');
  if (expectedContentVersion !== existing.contentVersion) throw conflict();
  if (!expectedUpdatedAt || new Date(expectedUpdatedAt).getTime() !== version.previous.getTime()) throw conflict();
  const result = await prisma.case.updateMany({
    where: { id, updatedAt: version.previous, contentVersion: existing.contentVersion, ...assignmentWhere(user) },
    data: { [field]: value, updatedAt: version.next, contentVersion: { increment: 1 } },
  });
  if (result.count !== 1) throw conflict();
  return prisma.case.findUnique({ where: { id }, include: caseContentInclude });
}
// Compare-and-swap retries make independent additions commute. Each request has
// a stable ID so a lost response followed by a retry cannot duplicate a log.
export async function appendCaseLog(id, user, entry) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await editableCase(id, user);
    const logs = normalizeStoredLogs(existing.logs);
    const prior = logs.find(log => log && log.id === entry.id);
    if (prior) {
      const same = prior.note === entry.note
        && (entry.date === undefined || prior.date === entry.date)
        && (prior.tag ?? null) === (entry.tag ?? null)
        && (prior.tagBy ?? null) === (entry.tagBy ?? null)
        && (prior.fromMeeting ?? null) === (entry.fromMeeting ?? null);
      if (!same) throw new CaseEditError(409, 'log_request_conflict', '這筆送出的識別碼已用於其他內容；既有紀錄未更動，請重新送出。');
      return { ...existing, logs };
    }
    if (logs.length >= 500) throw new CaseEditError(422, 'log_limit', '日誌已達 500 則，未新增，也未移除既有紀錄。');
    const version = stamp(existing);
    if (!Number.isSafeInteger(existing.contentVersion) || existing.contentVersion < 0) throw new Error('Case content version unavailable');
    const log = { ...entry, date: entry.date || taipeiLogDate(), by: user.name || '' };
    const result = await prisma.case.updateMany({
      where: { id, updatedAt: version.previous, contentVersion: existing.contentVersion, ...assignmentWhere(user) },
      data: { logs: [log, ...logs], updatedAt: version.next, contentVersion: { increment: 1 } },
    });
    if (result.count === 1) return prisma.case.findUnique({ where: { id }, include: caseContentInclude });
  }
  throw conflict();
}
