// ─────────────────────────────────────────────────────────────
// 會議會前提醒（M3）
// 每分鐘檢查啟用提醒、尚未提醒、未取消的會議，
// 當「現在」落在 [開始時間 - remindMinutes, 開始時間] 內 → 通知主持人+與會者。
// 會議時間為 Asia/Taipei 牆鐘時間（date@Date + startTime "HH:MM"）。
// ─────────────────────────────────────────────────────────────
import { prisma } from '../lib/db.js';
import { notify } from './notify.js';

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
        const recipients = [...new Set([m.hostId, ...m.attendees.map((a) => a.staffId)].filter(Boolean))];
        const ymd = new Date(m.date).toISOString().slice(0, 10);
        for (const rid of recipients) {
          await notify({
            type: 'meetingReminder', recipientId: rid, relatedCaseId: m.caseId || null,
            subject: `【會議提醒】${m.title} 即將開始`,
            body: `提醒您，會議「${m.title}」將於 ${ymd} ${m.startTime} 開始。\n地點：${m.location || '（未填）'}`,
          }).catch(() => {});
        }
        await prisma.meeting.update({ where: { id: m.id }, data: { remindedAt: new Date() } });
      } else if (now > start) {
        // 已過開始時間仍未提醒（伺服器當時可能未運行）→ 標記避免日後誤發
        await prisma.meeting.update({ where: { id: m.id }, data: { remindedAt: new Date() } });
      }
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
