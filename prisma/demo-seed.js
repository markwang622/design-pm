// Guarded, explicit Demo reset. No identity provisioning, credentials in logs,
// email delivery, or partial wipe: all business data changes share one transaction.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { prisma } from '../src/lib/db.js';
import { ConfigurationError, validateRuntimeConfig } from '../src/lib/runtimeConfig.js';
import { DatabaseIdentityError, validateDemoResetConfig, assertDemoDatabase } from '../src/lib/databaseIdentity.js';
import { taipeiCalendarDay } from '../src/services/analytics.js';

async function wipe(tx) {
  // REPORTS-P1-A: delivery evidence is append-only; this explicit Demo reset opens the
  // transaction-local purge switch so it can be removed before cases (RESTRICT FK).
  await tx.$queryRawUnsafe("SELECT set_config('design_pm.allow_delivery_purge', 'on', true)");
  for (const model of ['meetingAttendee', 'meeting', 'businessTrip', 'vacation', 'shoot', 'scheduleRequest', 'lifecycleRequest', 'deliverySubmission', 'deliveryRecord', 'caseCycle', 'changeLog', 'transferLog', 'notification', 'case', 'staff', 'hotel', 'requestUnit']) {
    await tx[model].deleteMany({});
  }
  // deploymentIdentity is intentionally excluded and is never modified.
}
async function seedDicts(tx) {
  await tx.hotel.createMany({ data: [
    { region: '集團', name: '集團本部', sortOrder: 10 },
    { region: '新竹', name: '新竹湖濱館', sortOrder: 20 },
    { region: '台南', name: '台南館', sortOrder: 30 },
    { region: '宜蘭', name: '宜蘭館', sortOrder: 40 },
    { region: '花蓮', name: '花蓮館', sortOrder: 50 },
  ] });
  await tx.requestUnit.createMany({ data: ['集團執辦', '餐飲行銷', '客房行銷', '客務部', '餐飲部'].map((name, index) => ({ name, sortOrder: (index + 1) * 10 })) });
}
async function seedDemo(tx, hash, now) {
  const base = taipeiCalendarDay(now);
  const addDays = days => new Date(base.getTime() + days * 86400000);
  const ymd = date => date.toISOString().slice(0, 10);
  // ─── test_ 帳號：涵蓋每個角色 ───────────────────────────
  const staffData = [
    { name: 'test_admin',    email: 'test_admin@demo.local',    role: 'admin',    seniority: 'senior', roleTitle: '設計主管（管理員）', joined: addDays(-1200) },
    { name: 'test_designer1', email: 'test_designer1@demo.local', role: 'member',   seniority: 'senior', roleTitle: '資深設計師',       joined: addDays(-800) },
    { name: 'test_designer2', email: 'test_designer2@demo.local', role: 'member',   seniority: 'mid',    roleTitle: '設計師',           joined: addDays(-400) },
    { name: 'test_observer',  email: 'test_observer@demo.local',  role: 'observer', seniority: 'mid',    roleTitle: '觀察者（唯讀）',     joined: addDays(-200) },
  ];
  const staff = {};
  for (const s of staffData) {
    staff[s.name] = await tx.staff.create({ data: { ...s, password: hash } });
  }

  // ─── 案件（相對今天：逾期 / 本週 / 未來 / 已結案）─────────
  const mk = (o) => {
    const { designer, collaborators = [], ...rest } = o;
    return tx.case.create({
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
    logs: [{ date: ymd(addDays(-8)), note: '第一版提案已送客戶', by: 'test_designer1' }],
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

  // ─── 會議（會前提醒、議程、待辦、出席回覆、關聯案件）─────
  await tx.meeting.create({
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
  await tx.meeting.create({
    data: {
      title: '【範例】部門週會', agenda: '各案進度同步。', date: addDays(6), startTime: '10:00', endTime: '10:30',
      type: 'internal', status: 'scheduled', remindMinutes: 10, hostId: staff['test_admin'].id, createdById: staff['test_admin'].id,
      actionItems: [], attendees: { create: [
        { staffId: staff['test_designer1'].id, response: 'pending' },
        { staffId: staff['test_designer2'].id, response: 'accepted' },
      ] },
    },
  });

  // ─── 出差 / 休假 / 拍攝 ────────────────────────────────
  await tx.businessTrip.create({ data: { staffId: staff['test_designer1'].id, startDate: addDays(7), endDate: addDays(8), hotel: '花蓮館', task: '【範例】現場場勘與拍攝溝通', note: '測試出差顯示與行事曆。' } });
  await tx.vacation.create({ data: { staffId: staff['test_designer2'].id, startDate: addDays(10), endDate: addDays(11), type: 'annual', note: '【範例】特休' } });
  await tx.shoot.create({ data: { desc: '【範例】餐點情境拍攝 8 道', mode: 'outsource', startDate: addDays(5), endDate: addDays(5), photographer: '外部 王攝影工作室', hotel: '台南館', note: '測試拍攝行程與封存。', createdById: staff['test_admin'].id } });

  return { staff: 4, cases: 5, meetings: 2, schedules: 3 };
}

export async function resetDemoDatabase(client = prisma, { env = process.env, hashPassword = bcrypt.hash, now = new Date() } = {}) {
  validateRuntimeConfig(env);
  const { password } = validateDemoResetConfig(env);
  await assertDemoDatabase(client, env);
  const hash = await hashPassword(password, 12);
  return client.$transaction(async tx => {
    // Recheck the independently provisioned identity in the same snapshot as
    // the destructive writes. The identity is preserved across resets.
    await assertDemoDatabase(tx, env);
    await wipe(tx);
    await seedDicts(tx);
    return seedDemo(tx, hash, now);
  }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 30000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetDemoDatabase()
    .then(() => console.log('[demo] Reset committed with synthetic test accounts and sample records; no credentials printed.'))
    .catch(e => {
      console.error('[demo]', e instanceof ConfigurationError || e instanceof DatabaseIdentityError ? e.message : 'Reset failed; transaction rolled back. Verify database availability, identity and migration status before retrying.');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
