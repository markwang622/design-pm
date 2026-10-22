// ─────────────────────────────────────────────────────────────
// iCal 訂閱 — 使用可撤銷的個人 bearer token（行事曆訂閱不帶 cookie）。
// 輸出案件上線日 + 拍攝 + 休假 + 出差，供 Google/Apple 行事曆訂閱。
// ─────────────────────────────────────────────────────────────
import { safeRouter } from '../lib/safeRouter.js';
import { prisma } from '../lib/db.js';
import { authenticateCalendarSubscription, calendarPrivacyHeaders, CalendarConfigurationError } from '../services/calendarSubscription.js';

const router = safeRouter(); // v9.6: async 錯誤一律交給 error middleware
router.use(calendarPrivacyHeaders);

const pad = (n) => String(n).padStart(2, '0');
function ymd(d) {
  const x = new Date(d);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}`;
}
function plusDay(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + 1);
  return x;
}
// 轉義 iCal 文字（逗號/分號/換行）
function esc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function vevent({ uid, start, end, summary }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${ymd(new Date())}T000000Z`,
    `DTSTART;VALUE=DATE:${ymd(start)}`,
    `DTEND;VALUE=DATE:${ymd(end)}`,
    `SUMMARY:${esc(summary)}`,
    'END:VEVENT',
  ].join('\r\n');
}
// 帶時間的事件（會議）：date@Date + "HH:MM" Taipei 牆鐘 → UTC 絕對時間
const pad2 = (n) => String(n).padStart(2, '0');
function utcStamp(d) {
  const x = new Date(d);
  return `${x.getUTCFullYear()}${pad2(x.getUTCMonth() + 1)}${pad2(x.getUTCDate())}T${pad2(x.getUTCHours())}${pad2(x.getUTCMinutes())}00Z`;
}
function timedEvent({ uid, dateObj, startTime, endTime, summary, location }) {
  const ymdStr = new Date(dateObj).toISOString().slice(0, 10);
  const startUtc = new Date(`${ymdStr}T${startTime}:00+08:00`);
  const endUtc = new Date(`${ymdStr}T${endTime}:00+08:00`);
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${ymd(new Date())}T000000Z`,
    `DTSTART:${utcStamp(startUtc)}`,
    `DTEND:${utcStamp(endUtc)}`,
    `SUMMARY:${esc(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${esc(location)}`);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

router.get('/calendar.ics', async (req, res) => {
  // No legacy shared key or caller-supplied scope/name can override the signed grant.
  if (Object.keys(req.query).some(key => key !== 'token') || typeof req.query.token !== 'string') {
    return res.status(403).send('forbidden');
  }
  try {
    const grant = await authenticateCalendarSubscription(req.query.token);
    if (!grant) return res.status(403).send('forbidden');
    const mine = grant.scope === 'mine';
    const who = grant.name;
    const staffId = grant.staffId;
    const mineCase = c => !mine || c.designerId === staffId || c.collaborators.some(s => s.id === staffId);
    const mineStaff = row => !mine || row.staffId === staffId;
    // Photographer is free text, not an authenticated staff relationship.
    const mineShoot = s => !mine || s.createdById === staffId;
    const mineMeeting = m => !mine || m.hostId === staffId || m.attendees.some(a => a.staffId === staffId);

    const [cases, shoots, vacs, trips, meetings] = await Promise.all([
      prisma.case.findMany({ where: { archived: false, ...(mine ? { OR: [{ designerId: staffId }, { collaborators: { some: { id: staffId } } }] } : {}) }, select: { id: true, title: true, goLiveDate: true, designerId: true, collaborators: { select: { id: true } } }, orderBy: { goLiveDate: 'asc' } }),
      prisma.shoot.findMany({ where: mine ? { createdById: staffId } : {}, select: { id: true, desc: true, mode: true, startDate: true, endDate: true, photographer: true, createdById: true } }),
      prisma.vacation.findMany({ where: mine ? { staffId } : {}, include: { staff: { select: { name: true } } } }),
      prisma.businessTrip.findMany({ where: mine ? { staffId } : {}, include: { staff: { select: { name: true } } } }),
      prisma.meeting.findMany({ where: { status: { not: 'cancelled' }, ...(mine ? { OR: [{ hostId: staffId }, { attendees: { some: { staffId } } }] } : {}) }, select: { id: true, title: true, date: true, startTime: true, endTime: true, location: true, hostId: true, host: { select: { name: true } }, attendees: { select: { staffId: true } } } }),
    ]);

    const events = [];
    for (const c of cases) {
      if (c.goLiveDate && mineCase(c)) events.push(vevent({ uid: `case-${c.id}-golive@design-pm`, start: c.goLiveDate, end: plusDay(c.goLiveDate), summary: `▲ 上線：${c.title}` }));
    }
    for (const s of shoots) {
      if (!mineShoot(s)) continue;
      const mode = s.mode === 'outsource' ? '外發' : '自拍';
      events.push(vevent({ uid: `shoot-${s.id}@design-pm`, start: s.startDate, end: plusDay(s.endDate), summary: `📷 ${mode} ${s.desc}${s.photographer ? ' · ' + s.photographer : ''}` }));
    }
    const VAC_LABEL = { annual: '特休', sick: '病假', personal: '事假', other: '其他' };
    for (const v of vacs) {
      if (!mineStaff(v)) continue;
      events.push(vevent({ uid: `vac-${v.id}@design-pm`, start: v.startDate, end: plusDay(v.endDate), summary: `🏖 ${v.staff?.name || ''} ${VAC_LABEL[v.type] || v.type}` }));
    }
    for (const t of trips) {
      if (!mineStaff(t)) continue;
      events.push(vevent({ uid: `trip-${t.id}@design-pm`, start: t.startDate, end: plusDay(t.endDate), summary: `✈ ${t.staff?.name || ''} 出差 ${t.hotel || ''}` }));
    }
    for (const m of meetings) {
      if (!mineMeeting(m)) continue;
      events.push(timedEvent({ uid: `meeting-${m.id}@design-pm`, dateObj: m.date, startTime: m.startTime, endTime: m.endTime, summary: `🗓 ${m.title}${m.host?.name ? ' · 主持 ' + m.host.name : ''}`, location: m.location }));
    }

    const calName = mine ? `藝術設計部 · ${who} 的排程` : '藝術設計部 · 團隊行事曆';
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Design-PM//Calendar//ZH-TW',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc(calName)}`,
      'X-WR-TIMEZONE:Asia/Taipei',
      ...events,
      'END:VCALENDAR',
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="design-pm.ics"');
    res.send(ics);
  } catch (e) {
    if (e instanceof CalendarConfigurationError) return res.status(503).send('calendar_unavailable');
    console.error('[ical] failed:', e.message);
    res.status(500).send('error');
  }
});

export default router;
