// ─────────────────────────────────────────────────────────────
// 會議會前提醒（M3）
// 每分鐘檢查啟用提醒、尚未提醒、未取消的會議，
// 當「現在」落在 [開始時間 - remindMinutes, 開始時間] 內 → 通知主持人+與會者。
// 會議時間為 Asia/Taipei 牆鐘時間（date@Date + startTime "HH:MM"）。
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';
import { deliver } from './notify.js';

function meetingStartInstant(dateObj, startTime) {
  const ymd = new Date(dateObj).toISOString().slice(0, 10);
  return new Date(`${ymd}T${startTime}:00+08:00`); // Taipei 牆鐘 → 絕對時間
}

let _running = false;
export async function checkMeetingReminders() {
  if (_running) return;
  _running = true;
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const meetings = await prisma.meeting.findMany({
      where: { remindMinutes: { gt: 0 }, remindedAt: null, status: { not: 'cancelled' }, date: { gte: since } },
      include: { attendees: { select: { staffId: true } } },
    });
    for (const m of meetings) {
      const start = meetingStartInstant(m.date, m.startTime);
      const windowStart = new Date(start.getTime() - m.remindMinutes * 60000);
      if (now >= windowStart && now <= start) {
        try {
          // The durable in-app notifications and the completion marker commit
          // together. A failed recipient or competing worker rolls back the
          // entire batch, so retry cannot duplicate successful recipients.
          const delivery = await prisma.$transaction(async (tx) => {
            const current = await tx.meeting.findUnique({ where: { id: m.id }, include: { attendees: { select: { staffId: true } } } });
            if (!current || current.remindedAt || current.status === 'cancelled' || current.remindMinutes <= 0) return null;
            const currentStart = meetingStartInstant(current.date, current.startTime);
            if (now < new Date(currentStart.getTime() - current.remindMinutes * 60000) || now > currentStart) return null;
            const recipients = [...new Set([current.hostId, ...current.attendees.map((a) => a.staffId)].filter(Boolean))];
            if (!recipients.length) return null;
            const ymd = new Date(current.date).toISOString().slice(0, 10);
            const subject = `【會議提醒】${current.title} 即將開始`;
            const body = `提醒您，會議「${current.title}」將於 ${ymd} ${current.startTime} 開始。\n地點：${current.location || '（未填）'}`;
            for (const recipientId of recipients) {
              await tx.notification.create({ data: { type: 'meetingReminder', recipientId, relatedCaseId: current.caseId || null, subject, body } });
            }
            await tx.meeting.update({ where: { id: current.id }, data: { remindedAt: new Date() } });
            return { recipients, subject, body };
          }, { isolationLevel: 'Serializable' });
          // SMTP is best effort after DB commit; delivery failure must not erase
          // the successfully persisted in-app reminder or open a duplicate batch.
          if (delivery) {
            for (const rid of delivery.recipients) {
              try {
                const recipient = await prisma.staff.findUnique({ where: { id: rid }, select: { email: true, active: true } });
                if (recipient?.active && recipient.email) await deliver(recipient.email, delivery.subject, delivery.body);
              } catch (e) { console.warn('[meeting-reminder] email failed:', e.message); }
            }
          }
        } catch (e) { console.warn('[meeting-reminder] delivery deferred:', e.message); }
      }
      // Expired windows remain unmarked: remindedAt means a durable reminder
      // was created, rather than merely that the scheduler observed the meeting.
    }
  } catch (e) {
    console.warn('[meeting-reminder] check failed:', e.message);
  } finally {
    _running = false;
  }
}

export function startMeetingReminderLoop() {
  setInterval(checkMeetingReminders, 60 * 1000);
  setTimeout(checkMeetingReminders, 10 * 1000);
  console.log('[meeting-reminder] loop started (every 60s)');
}
