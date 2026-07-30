// ─────────────────────────────────────────────────────────────
// DEMO 重置腳本 — 專用於「artdesign-for-demo」測試站。
//
// ⚠️ 會清空所有業務資料後灌入 test_ 測試帳號與範例資料。
// 安全防呆：必須設環境變數 DEMO_SEED=yes 才會執行，避免誤清正式站。
//
// 用法（在 demo 服務的 Zeabur 主控台或本機指向 demo DATABASE_URL）：
//   DEMO_SEED=yes npm run demo-seed
//
// 帳號密碼統一為 DEMO_PASSWORD（預設 Demo2026test），登入用。
// ─────────────────────────────────────────────────────────────
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

if (process.env.DEMO_SEED !== 'yes') {
  console.error('\n✋ 拒絕執行：這支腳本會清空所有資料。');
  console.error('   確定是在 DEMO 資料庫，請加環境變數：DEMO_SEED=yes npm run demo-seed\n');
  process.exit(1);
}

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo2026test';

// 相對今天的 UTC 日期（demo 不管哪天打開都看得到當前的逾期/本週/未來項）
const base = new Date();
const addDays = (n) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + n));
const ymd = (dt) => dt.toISOString().slice(0, 10);

async function wipe() {
  // FK 安全順序：先子表、再主表
  await prisma.meetingAttendee.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.businessTrip.deleteMany();
  await prisma.vacation.deleteMany();
  await prisma.shoot.deleteMany();
  await prisma.changeLog.deleteMany();
  await prisma.transferLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.case.deleteMany();       // 多對多 collaborators 會一併解除
  await prisma.staff.deleteMany();
  console.log('[demo] 已清空所有業務資料');
}

async function seedDicts() {
  const hotels = [
    { region: '集團', name: '集團本部', sortOrder: 10 },
    { region: '新竹', name: '新竹湖濱館', sortOrder: 20 },
    { region: '台南', name: '台南館', sortOrder: 30 },
    { region: '宜蘭', name: '宜蘭館', sortOrder: 40 },
    { region: '花蓮', name: '花蓮館', sortOrder: 50 },
  ];
  for (const h of hotels) await prisma.hotel.upsert({ where: { name: h.name }, create: h, update: {} });
  const units = ['集團執辦', '餐飲行銷', '客房行銷', '客務部', '餐飲部'];
  let i = 10;
  for (const name of units) { await prisma.requestUnit.upsert({ where: { name }, create: { name, sortOrder: i }, update: {} }); i += 10; }
  console.log('[demo] 館別 / 需求單位 就緒');
}

async function main() {
  await wipe();
  await seedDicts();
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // ─── test_ 帳號：涵蓋每個角色 ───────────────────────────
  const staffData = [
    { name: 'test_admin',    email: 'test_admin@demo.local',    role: 'admin',    seniority: 'senior', roleTitle: '設計主管（管理員）', joined: addDays(-1200) },
    { name: 'test_designer1', email: 'test_designer1@demo.local', role: 'member',   seniority: 'senior', roleTitle: '資深設計師',       joined: addDays(-800) },
    { name: 'test_designer2', email: 'test_designer2@demo.local', role: 'member',   seniority: 'mid',    roleTitle: '設計師',           joined: addDays(-400) },
    { name: 'test_observer',  email: 'test_observer@demo.local',  role: 'observer', seniority: 'mid',    roleTitle: '觀察者（唯讀）',     joined: addDays(-200) },
  ];
  const staff = {};
  for (const s of staffData) {
    staff[s.name] = await prisma.staff.create({ data: { ...s, password: hash } });
  }
  console.log(`[demo] 建立 ${staffData.length} 個 test_ 帳號`);

  // ─── 案件（相對今天：逾期 / 本週 / 未來 / 已結案）─────────
  const mk = (o) => {
    const { designer, collaborators = [], ...rest } = o;
    return prisma.case.create({
      data: {
        ...rest,
        designer: { connect: { id: staff[designer].id } },
        collaborators: { connect: collaborators.map((n) => ({ id: staff[n].id })) },
        createdBy: { connect: { id: staff['test_admin'].id } },
      },
    });
  };
  await mk({
    id: 'TEST-A-001', title: '【範例】母親節主視覺（逾期示範）', subTitle: 'KV + 社群', hotel: '新竹湖濱館', requester: '客房行銷',
    designer: 'test_designer1', collaborators: ['test_designer2'], level: 'A', category: '1 平面設計製作物', status: 'doing',
    urgent: true, contact: '行銷 陳經理', deliverables: ['主視覺 KV', 'IG 貼文 3 款'],
    openDate: addDays(-14), dispatchDate: addDays(-14), copyDate: addDays(-10), goLiveDate: addDays(-3),
    note: '此案上線日已過 → 會出現在「逾期」清單，方便測試逾期呈現。',
    logs: [{ date: ymd(addDays(-8)), text: '第一版提案已送客戶', author: 'test_designer1' }],
  });
  await mk({
    id: 'TEST-B-002', title: '【範例】官網 Banner（本週上線）', subTitle: '首頁輪播 3 款', hotel: '宜蘭館', requester: '客房行銷',
    designer: 'test_designer1', level: 'B', category: '2 數位廣宣', status: 'review',
    openDate: addDays(-6), dispatchDate: addDays(-6), copyDate: addDays(-3), goLiveDate: addDays(2),
    note: '狀態＝確稿中，本週上線，測試「本週到期 / 確稿」。',
  });
  await mk({
    id: 'TEST-C-003', title: '【範例】菜單改版（未來案）', subTitle: '全餐廳 A/B', hotel: '台南館', requester: '餐飲部',
    designer: 'test_designer2', level: 'A', category: '1 平面設計製作物', status: 'todo', needsOutsourcing: true,
    openDate: addDays(-1), dispatchDate: addDays(-1), goLiveDate: addDays(21),
    note: '尚未開始、需發包，測試發包建議日與甘特未來排程。',
  });
  await mk({
    id: 'TEST-D-004', title: '【範例】春季 DM（進行中）', subTitle: '12P 雙面', hotel: '花蓮館', requester: '餐飲行銷',
    designer: 'test_designer2', collaborators: ['test_designer1'], level: 'A', category: '1 平面設計製作物', status: 'doing',
    openDate: addDays(-4), dispatchDate: addDays(-4), copyDate: addDays(-1), goLiveDate: addDays(9),
    note: 'test_designer1 為協作者，測試「協作參與」分區。',
  });
  await mk({
    id: 'TEST-E-005', title: '【範例】兒童節活動（已結案）', subTitle: 'KV + 素材', hotel: '花蓮館', requester: '客房行銷',
    designer: 'test_designer1', level: 'B', category: '2 數位廣宣', status: 'closed', archived: true,
    openDate: addDays(-40), dispatchDate: addDays(-40), copyDate: addDays(-36), goLiveDate: addDays(-25),
    closedOn: addDays(-24), actualWorkdays: 8, requestCount: 3, outputCount: 12,
    archivePath: '/設計部共用/2026/範例/兒童節活動', note: '已結案並封存，測試「歷史案件」與「本月結案」。',
  });
  console.log('[demo] 建立 5 筆範例案件（逾期/本週/未來/協作/已結案）');

  // ─── 會議（會前提醒、議程、待辦、出席回覆、關聯案件）─────
  const m1 = await prisma.meeting.create({
    data: {
      title: '【範例】母親節主視覺提案會議', agenda: '確認 KV 方向、分工與時程；檢視第一版提案。',
      date: addDays(2), startTime: '14:00', endTime: '15:00', location: '3F 會議室 / Google Meet',
      type: 'proposal', status: 'scheduled', remindMinutes: 30, caseId: 'TEST-A-001',
      minutes: '', actionItems: [
        { text: '修正 KV 主色，週四前回覆', owner: 'test_designer1', done: false },
        { text: '準備 IG 尺寸稿', owner: 'test_designer2', done: false },
      ],
      hostId: staff['test_admin'].id, createdById: staff['test_admin'].id,
      attendees: {
        create: [
          { staffId: staff['test_designer1'].id, response: 'accepted' },
          { staffId: staff['test_designer2'].id, response: 'pending' },
        ],
      },
    },
  });
  await prisma.meeting.create({
    data: {
      title: '【範例】部門週會', agenda: '各案進度同步。', date: addDays(6), startTime: '10:00', endTime: '10:30',
      type: 'internal', status: 'scheduled', remindMinutes: 10, hostId: staff['test_admin'].id, createdById: staff['test_admin'].id,
      actionItems: [], attendees: { create: [
        { staffId: staff['test_designer1'].id, response: 'pending' },
        { staffId: staff['test_designer2'].id, response: 'accepted' },
      ] },
    },
  });
  console.log('[demo] 建立 2 場範例會議（含議程/待辦/提醒/出席）');

  // ─── 出差 / 休假 / 拍攝 ────────────────────────────────
  await prisma.businessTrip.create({ data: { staffId: staff['test_designer1'].id, startDate: addDays(7), endDate: addDays(8), hotel: '花蓮館', task: '【範例】現場場勘與拍攝溝通', note: '測試出差顯示與行事曆。' } });
  await prisma.vacation.create({ data: { staffId: staff['test_designer2'].id, startDate: addDays(10), endDate: addDays(11), type: 'annual', note: '【範例】特休' } });
  await prisma.shoot.create({ data: { desc: '【範例】餐點情境拍攝 8 道', mode: 'outsource', startDate: addDays(5), endDate: addDays(5), photographer: '外部 王攝影工作室', hotel: '台南館', note: '測試拍攝行程與封存。', createdById: staff['test_admin'].id } });
  console.log('[demo] 建立 出差 / 休假 / 拍攝 各 1 筆');

  console.log('\n┌───────────────────────────────────────────────┐');
  console.log('│  DEMO 測試站已就緒                              │');
  console.log('├───────────────────────────────────────────────┤');
  console.log(`│  統一密碼：${DEMO_PASSWORD.padEnd(32)}│`);
  console.log('│  test_admin@demo.local      （管理員）         │');
  console.log('│  test_designer1@demo.local  （資深設計師）     │');
  console.log('│  test_designer2@demo.local  （設計師）         │');
  console.log('│  test_observer@demo.local   （觀察者·唯讀）    │');
  console.log('└───────────────────────────────────────────────┘');
}

main()
  .catch((e) => { console.error('[demo] error:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
