// ─────────────────────────────────────────────────────────────
// Notification helpers — writes to DB only (no real SMTP yet).
// When you add an email provider, swap `deliver` for a real call.
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';

export async function notify({ type, recipientId, subject, body, relatedCaseId }) {
  return prisma.notification.create({
    data: { type, recipientId, subject, body, relatedCaseId: relatedCaseId ?? null },
  });
}

export async function notifyMany(items) {
  return prisma.notification.createMany({ data: items });
}

/**
 * Template: 新案派發
 */
export function tplCaseAssigned({ caseRow, operatorName }) {
  return {
    subject: `【新案派發】${caseRow.id}｜${caseRow.title}`,
    body:
      `${operatorName} 已將下列案件派發給您：\n\n` +
      `案號：${caseRow.id}\n` +
      `標題：${caseRow.title}\n` +
      `等級：${caseRow.level}\n` +
      `需求方：${caseRow.requester}\n` +
      `截止日：${isoDate(caseRow.goLiveDate)}\n\n` +
      `請於系統中確認並開始執行。`,
  };
}

export function tplCollabInvite({ caseRow, operatorName }) {
  return {
    subject: `【協作邀請】${caseRow.id}｜${caseRow.title}`,
    body:
      `${operatorName} 邀請您協助下列案件：\n\n` +
      `案號：${caseRow.id}\n` +
      `標題：${caseRow.title}\n` +
      `等級：${caseRow.level}\n` +
      `主責：${caseRow.designerName ?? '—'}\n` +
      `截止日：${isoDate(caseRow.goLiveDate)}\n\n` +
      `您可在系統中檢視與協助此案。`,
  };
}

export function tplStaffAdd({ newStaff }) {
  return {
    subject: `【新進成員】${newStaff.name} 加入設計部`,
    body:
      `設計部新進成員報到：\n\n` +
      `姓名：${newStaff.name}\n` +
      `信箱：${newStaff.email}\n` +
      `年資：${newStaff.seniority}\n` +
      `到職日：${isoDate(newStaff.joined)}\n`,
  };
}

export function tplDeparture({ leaver, transferred, archived, removedCollab }) {
  const transferLines =
    transferred.length === 0
      ? '（無未完成主責案）'
      : transferred.map((t) => `  - ${t.caseId} → ${t.toName}`).join('\n');
  return {
    subject: `【人員離職】${leaver.name} 案件移轉通知`,
    body:
      `${leaver.name}（到職日 ${isoDate(leaver.joined)}）已確認離職。\n\n` +
      `已封存已完成案件 ${archived.length} 件：\n` +
      (archived.length ? archived.map((a) => `  - ${a}`).join('\n') + '\n\n' : '（無）\n\n') +
      `未完成案件移轉：\n${transferLines}\n\n` +
      `已自動解除協作關係 ${removedCollab.length} 件。\n\n` +
      `請接手同仁於 3 個工作日內確認案件內容。`,
  };
}

function isoDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
