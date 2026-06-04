// ─────────────────────────────────────────────────────────────
// iCal 訂閱（J2）— 免登入，用 ?key= 驗證（行事曆訂閱不帶 cookie）。
// 輸出案件上線日 + 拍攝 + 休假 + 出差，供 Google/Apple 行事曆訂閱。
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { prisma } from '../lib/db.js';

const router = Router();
const ICAL_KEY = process.env.ICAL_KEY || 'design-pm-cal';

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

router.get('/calendar.ics', async (req, res) => {
  if ((req.query.key || '') !== ICAL_KEY) return res.status(403).send('forbidden');
  try {
    const [cases, shoots, vacs, trips] = await Promise.all([
      prisma.case.findMany({ where: { archived: false }, select: { id: true, title: true, goLiveDate: true }, orderBy: { goLiveDate: 'asc' } }),
      prisma.shoot.findMany({ select: { id: true, desc: true, mode: true, startDate: true, endDate: true, photographer: true } }),
      prisma.vacation.findMany({ include: { staff: { select: { name: true } } } }),
      prisma.businessTrip.findMany({ include: { staff: { select: { name: true } } } }),
    ]);

    const events = [];
    for (const c of cases) {
      if (c.goLiveDate) events.push(vevent({ uid: `case-${c.id}-golive@design-pm`, start: c.goLiveDate, end: plusDay(c.goLiveDate), summary: `▲ 上線：${c.title}` }));
    }
    for (const s of shoots) {
      const mode = s.mode === 'outsource' ? '外發' : '自拍';
      events.push(vevent({ uid: `shoot-${s.id}@design-pm`, start: s.startDate, end: plusDay(s.endDate), summary: `📷 ${mode} ${s.desc}${s.photographer ? ' · ' + s.photographer : ''}` }));
    }
    const VAC_LABEL = { annual: '特休', sick: '病假', personal: '事假', other: '其他' };
    for (const v of vacs) {
      events.push(vevent({ uid: `vac-${v.id}@design-pm`, start: v.startDate, end: plusDay(v.endDate), summary: `🏖 ${v.staff?.name || ''} ${VAC_LABEL[v.type] || v.type}` }));
    }
    for (const t of trips) {
      events.push(vevent({ uid: `trip-${t.id}@design-pm`, start: t.startDate, end: plusDay(t.endDate), summary: `✈ ${t.staff?.name || ''} 出差 ${t.hotel || ''}` }));
    }

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Design-PM//Calendar//ZH-TW',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:藝術設計部 · 行事曆',
      'X-WR-TIMEZONE:Asia/Taipei',
      ...events,
      'END:VCALENDAR',
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="design-pm.ics"');
    res.send(ics);
  } catch (e) {
    console.error('[ical] failed:', e.message);
    res.status(500).send('error');
  }
});

export default router;
