// ─────────────────────────────────────────────────────────────
// Notification helpers
//
// Two channels:
//   1. DB notification (always written) — visible in /api/notifications
//   2. SMTP email (optional) — sent if env vars set; otherwise dry-run logs
//
// SMTP env vars (set in Zeabur Variables to enable):
//   SMTP_HOST   — e.g. smtp.gmail.com / smtp.sendgrid.net
//   SMTP_PORT   — 587 (TLS) or 465 (SSL)
//   SMTP_USER   — login user
//   SMTP_PASS   — app password / API key
//   SMTP_FROM   — From: header (e.g. "Design-PM <noreply@…>")
//   SMTP_SECURE — 'true' for SSL on port 465; default false (STARTTLS on 587)
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';

let _transporter = null;
let _smtpDisabled = false;

async function getTransporter() {
  if (_smtpDisabled) return null;
  if (_transporter) return _transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    _smtpDisabled = true;
    console.log('[notify] SMTP not configured — email delivery disabled (DB notifications still write).');
    return null;
  }
  try {
    const { default: nodemailer } = await import('nodemailer');
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return _transporter;
  } catch (e) {
    console.warn('[notify] SMTP setup failed (nodemailer not installed?):', e.message);
    _smtpDisabled = true;
    return null;
  }
}

async function deliver(recipientEmail, subject, body) {
  const t = await getTransporter();
  if (!t || !recipientEmail) return false;
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || `Design-PM <${process.env.SMTP_USER}>`,
      to: recipientEmail,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });
    return true;
  } catch (e) {
    console.warn('[notify] SMTP send failed for', recipientEmail, ':', e.message);
    return false;
  }
}

// v4.3 C: Email dedupe window (in hours). Same (type, recipientId, relatedCaseId)
// within this window will write DB notification but SKIP the email delivery,
// unless caller passes `force: true`.
const DEDUPE_WINDOW_HOURS = Number(process.env.NOTIFY_DEDUPE_HOURS || 6);

async function shouldSendEmail({ type, recipientId, relatedCaseId, force }) {
  if (force) return true;
  // Only dedupe when relatedCaseId is meaningful — generic notifications
  // (no caseId) always send.
  if (!relatedCaseId) return true;
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 60 * 60 * 1000);
  const recent = await prisma.notification.findFirst({
    where: { type, recipientId, relatedCaseId, createdAt: { gte: since } },
    select: { id: true },
  });
  // If a similar notification exists in the window, skip email.
  return !recent;
}

export async function notify({ type, recipientId, subject, body, relatedCaseId, force }) {
  // (v4.3) Decide email send BEFORE writing the DB row, otherwise we'd always
  // see the just-written row and never send.
  const sendEmail = await shouldSendEmail({ type, recipientId, relatedCaseId, force });

  // Always write DB notification (timeline / unread counter still updates)
  const row = await prisma.notification.create({
    data: { type, recipientId, subject, body, relatedCaseId: relatedCaseId ?? null },
  });

  if (!sendEmail) {
    // Log so admin can see the suppression in deployment logs
    console.log(`[notify] dedupe: skip email for type=${type} recipient=${recipientId} case=${relatedCaseId} (similar within ${DEDUPE_WINDOW_HOURS}h)`);
    return row;
  }

  // Then attempt SMTP delivery (best-effort)
  try {
    const recipient = await prisma.staff.findUnique({
      where: { id: recipientId },
      select: { email: true, active: true },
    });
    if (recipient && recipient.active && recipient.email) {
      await deliver(recipient.email, subject, body);
    }
  } catch (e) {
    console.warn('[notify] email lookup/send error:', e.message);
  }
  return row;
}

export async function notifyMany(items) {
  // Note: bypasses email delivery (used for batch DB writes only)
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

// ─────────────────────────────────────────────────────────────
// v7.4 SMTP 設定自我診斷（admin 專用）
// 目的：管理員在 Zeabur 貼上 SMTP 設定後，能立刻確認成不成功，
// 而不必去翻部署日誌。永遠不回傳 SMTP_PASS。
// ─────────────────────────────────────────────────────────────
function maskEmail(e) {
  const [u, d] = String(e).split('@');
  if (!d) return '***';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(Math.max(1, u.length - 2))) + '@' + d;
}

export function smtpConfigStatus() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE, APP_BASE_URL } = process.env;
  const missing = [];
  if (!SMTP_HOST) missing.push('SMTP_HOST');
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASS) missing.push('SMTP_PASS');
  return {
    configured: missing.length === 0,
    missing,
    host: SMTP_HOST || null,
    port: Number(SMTP_PORT) || 587,
    secure: SMTP_SECURE === 'true',
    user: SMTP_USER ? maskEmail(SMTP_USER) : null,   // 遮蔽，且永不回傳密碼
    hasPass: !!SMTP_PASS,
    from: SMTP_FROM || (SMTP_USER ? `Design-PM <${SMTP_USER}>` : null),
    appBaseUrl: APP_BASE_URL || null,
  };
}

// 建一條全新連線做驗證 + 試寄，不沿用快取（避免舊的失敗狀態卡住診斷）
export async function sendTestMail(to) {
  const st = smtpConfigStatus();
  if (!st.configured) {
    return { ok: false, stage: 'config', message: `尚未設定：${st.missing.join('、')}` };
  }
  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch (e) {
    return { ok: false, stage: 'module', message: 'nodemailer 未安裝：' + e.message };
  }
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: st.port,
    secure: st.secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  try {
    await t.verify();
  } catch (e) {
    return { ok: false, stage: 'auth', message: e.message };
  }
  try {
    await t.sendMail({
      from: st.from,
      to,
      subject: '【藝術設計部】SMTP 測試信',
      text: '這是一封測試信。收到代表寄信設定成功，新成員的啟用連結就能自動寄出了。',
      html: '這是一封測試信。<br>收到代表寄信設定成功，新成員的啟用連結就能自動寄出了。',
    });
  } catch (e) {
    return { ok: false, stage: 'send', message: e.message };
  }
  // 設定成功後解除模組層的停用旗標，讓後續通知不必等重啟就能寄出
  _smtpDisabled = false;
  _transporter = null;
  return { ok: true, stage: 'sent', message: `測試信已寄至 ${to}` };
}
