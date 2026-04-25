// ─────────────────────────────────────────────────────────────
// Seed script — idempotent, safe to run on every deploy.
// Creates initial staff + sample cases only if tables are empty.
// ─────────────────────────────────────────────────────────────
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day));

const DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD || 'design2026!';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'wasimark0622@gmail.com';

async function main() {
  const existingStaff = await prisma.staff.count();
  if (existingStaff > 0) {
    console.log(`[seed] Skipped — staff table already has ${existingStaff} row(s).`);
    return;
  }

  console.log('[seed] Empty database detected, seeding initial data…');

  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  // ─── Staff ─────────────────────────────────────────────
  const staffData = [
    { name: 'Mark',     email: ADMIN_EMAIL,          role: 'admin',  joined: d(2019, 1, 1),  seniority: 'senior', roleTitle: '設計主管' },
    { name: 'Sunny',    email: 'sunny@company.com',    joined: d(2021, 3, 1),  seniority: 'senior' },
    { name: 'Milo',     email: 'milo@company.com',     joined: d(2020, 8, 15), seniority: 'senior' },
    { name: 'Amanda',   email: 'amanda@company.com',   joined: d(2022, 6, 10), seniority: 'mid' },
    { name: 'Jhen',     email: 'jhen@company.com',     joined: d(2023, 1, 3),  seniority: 'mid' },
    { name: 'Ruby',     email: 'ruby@company.com',     joined: d(2022, 11, 20), seniority: 'mid' },
    { name: 'Michelle', email: 'michelle@company.com', joined: d(2020, 2, 14), seniority: 'senior' },
    { name: 'Agnes',    email: 'agnes@company.com',    joined: d(2024, 5, 6),  seniority: 'junior' },
    { name: 'Mandy',    email: 'mandy@company.com',    joined: d(2024, 9, 2),  seniority: 'junior' },
  ];

  const staff = {};
  for (const s of staffData) {
    const row = await prisma.staff.create({
      data: { ...s, password: hash, role: s.role || 'member' },
    });
    staff[row.name] = row;
  }
  console.log(`[seed] Created ${Object.keys(staff).length} staff members`);

  // ─── Cases ─────────────────────────────────────────────
  const cases = [
    { id: 'SS-2026-04-001', title: '品牌更新', subTitle: '城旅 VIS 命名', hotel: '集團本部', requester: '集團執辦',
      designer: 'Sunny', collaborators: ['Michelle'], level: 'SS', category: '6 提案', status: 'doing',
      openDate: d(2026,4,2), dispatchDate: d(2026,4,2), copyDate: d(2026,4,4), goLiveDate: d(2026,4,30),
      urgent: false, note: '4/17 提供嘉義製作項目清單，待集團 VI 走向確認' },
    { id: 'A-2026-04-012', title: '餐飲季刊', subTitle: 'P.4 主視覺', hotel: '新竹湖濱館', requester: '餐飲行銷',
      designer: 'Sunny', collaborators: [], level: 'A', category: '1 平面設計製作物', status: 'review',
      openDate: d(2026,4,8), dispatchDate: d(2026,4,8), copyDate: d(2026,4,11), goLiveDate: d(2026,4,28),
      urgent: true, note: '客戶要求 4/28 上線，已提出第二版確稿' },
    { id: 'B-2026-04-028', title: '母親節 EDM', subTitle: '首圖 + CTA 測試', hotel: '宜蘭行銷', requester: '客房行銷',
      designer: 'Sunny', collaborators: ['Ruby'], level: 'B', category: '2 數位廣宣', status: 'doing',
      openDate: d(2026,4,15), dispatchDate: d(2026,4,15), copyDate: d(2026,4,17), goLiveDate: d(2026,5,6),
      urgent: false, note: '' },
    { id: 'C-2026-04-055', title: '官網 banner 替換', subTitle: '首頁輪播 3 款', hotel: '宜蘭館', requester: '客房行銷',
      designer: 'Sunny', collaborators: [], level: 'C', category: '2 數位廣宣', status: 'todo',
      openDate: d(2026,4,18), dispatchDate: d(2026,4,18), goLiveDate: d(2026,5,8), urgent: false, note: '' },
    { id: 'B-2026-04-041', title: '兒童節活動', subTitle: 'KV + 社群素材', hotel: '花蓮館', requester: '客房行銷',
      designer: 'Sunny', collaborators: [], level: 'B', category: '2 數位廣宣', status: 'done',
      openDate: d(2026,3,25), dispatchDate: d(2026,3,25), copyDate: d(2026,3,27), goLiveDate: d(2026,4,4),
      urgent: false, note: '結案報告 4/8 Mark 核可', requestCount: 3, outputCount: 12,
      closedOn: d(2026,4,4), actualWorkdays: 8, archivePath: '/設計部共用/2026/Q2/04-兒童節活動_花蓮館' },
    { id: 'A-2026-04-019', title: '春季房型 DM', subTitle: '12P 雙面', hotel: '新竹湖濱館', requester: '客房行銷',
      designer: 'Milo', collaborators: ['Agnes'], level: 'A', category: '1 平面設計製作物', status: 'doing',
      openDate: d(2026,4,1), dispatchDate: d(2026,4,1), copyDate: d(2026,4,5), goLiveDate: d(2026,4,30),
      urgent: false, note: '' },
    { id: 'B-2026-04-033', title: '5月 VIP 專刊', subTitle: '封面 + 目錄', hotel: '新竹都會館', requester: '客房行銷',
      designer: 'Milo', collaborators: [], level: 'B', category: '1 平面設計製作物', status: 'review',
      openDate: d(2026,4,10), dispatchDate: d(2026,4,10), copyDate: d(2026,4,13), goLiveDate: d(2026,4,28),
      urgent: true, note: '' },
    { id: 'C-2026-04-061', title: '官網 SEO 著陸頁', subTitle: '婚宴主題 3 款', hotel: '宜蘭館', requester: '客房行銷',
      designer: 'Milo', collaborators: [], level: 'C', category: '2 數位廣宣', status: 'wait',
      openDate: d(2026,4,12), dispatchDate: d(2026,4,12), goLiveDate: d(2026,5,12), urgent: false, note: '等文案' },
    { id: 'SS-2026-04-002', title: '新品牌 manual', subTitle: 'Logo 使用規範', hotel: '集團本部', requester: '集團執辦',
      designer: 'Milo', collaborators: ['Michelle', 'Sunny'], level: 'SS', category: '6 提案', status: 'doing',
      openDate: d(2026,3,20), dispatchDate: d(2026,3,20), goLiveDate: d(2026,4,23),
      urgent: false, note: '三人協作：Milo 主筆、Michelle 排版、Sunny 圖示系統' },
    { id: 'A-2026-04-022', title: '餐廳菜單改版', subTitle: '全餐廳 A/B', hotel: '台南館', requester: '餐飲部',
      designer: 'Amanda', collaborators: [], level: 'A', category: '1 平面設計製作物', status: 'doing',
      openDate: d(2026,4,5), dispatchDate: d(2026,4,5), copyDate: d(2026,4,10), goLiveDate: d(2026,5,4),
      urgent: false, note: '' },
    { id: 'A-2026-04-031', title: '傳藝夏季市集', subTitle: '主視覺 + DM', hotel: '傳藝館', requester: '客務部',
      designer: 'Jhen', collaborators: ['Mandy'], level: 'A', category: '1 平面設計製作物', status: 'doing',
      openDate: d(2026,3,28), dispatchDate: d(2026,3,28), copyDate: d(2026,4,1), goLiveDate: d(2026,4,27),
      urgent: false, note: '' },
    { id: 'A-2026-04-038', title: '餐飲 IG 廣告', subTitle: '5/1 上線', hotel: '新竹湖濱館', requester: '餐飲行銷',
      designer: 'Ruby', collaborators: [], level: 'A', category: '2 數位廣宣', status: 'review',
      openDate: d(2026,4,8), dispatchDate: d(2026,4,8), copyDate: d(2026,4,11), goLiveDate: d(2026,4,27),
      urgent: true, note: '' },
    { id: 'SS-2026-04-003', title: '集團年報', subTitle: '封面 + 封底', hotel: '集團本部', requester: '集團執辦',
      designer: 'Michelle', collaborators: ['Amanda'], level: 'SS', category: '6 提案', status: 'doing',
      openDate: d(2026,3,15), dispatchDate: d(2026,3,15), copyDate: d(2026,3,20), goLiveDate: d(2026,4,30),
      urgent: false, note: '' },
    { id: 'B-2026-04-057', title: '公關稿視覺', subTitle: '蘇澳 15 年慶', hotel: '蘇澳館', requester: '客房行銷',
      designer: 'Michelle', collaborators: [], level: 'B', category: '2 數位廣宣', status: 'done',
      openDate: d(2026,3,20), dispatchDate: d(2026,3,20), copyDate: d(2026,3,22), goLiveDate: d(2026,4,10),
      urgent: false, note: '', requestCount: 2, outputCount: 6, closedOn: d(2026,4,10), actualWorkdays: 15,
      archivePath: '/設計部共用/2026/Q2/04-公關稿-蘇澳館15年慶' },
    { id: 'A-2026-04-043', title: '日系咖啡廳識別', subTitle: 'logo + 指標', hotel: '花太館', requester: '餐飲部',
      designer: 'Agnes', collaborators: ['Jhen'], level: 'A', category: '6 提案', status: 'doing',
      openDate: d(2026,4,1), dispatchDate: d(2026,4,1), goLiveDate: d(2026,5,4), urgent: false, note: '' },
    { id: 'B-2026-04-060', title: '花蓮市場照', subTitle: '自拍 50 張', hotel: '花蓮館', requester: '客務部',
      designer: 'Mandy', collaborators: [], level: 'B', category: '4 拍攝(自拍)', status: 'wait',
      openDate: d(2026,4,14), dispatchDate: d(2026,4,14), goLiveDate: d(2026,5,12), urgent: false, note: '等天氣' },
  ];

  for (const c of cases) {
    const { designer, collaborators, ...rest } = c;
    // Default creator = admin (Mark) for seeded cases
    await prisma.case.create({
      data: {
        ...rest,
        designer:      { connect: { id: staff[designer].id } },
        collaborators: { connect: collaborators.map(n => ({ id: staff[n].id })) },
        createdBy:     { connect: { id: staff['Mark'].id } },
      },
    });
  }
  console.log(`[seed] Created ${cases.length} sample cases`);

  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│  初始登入資訊                                │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  管理員: ${ADMIN_EMAIL.padEnd(30)}│`);
  console.log(`│  密碼:   ${DEFAULT_PASSWORD.padEnd(30)}│`);
  console.log('│  其他成員統一使用上方密碼，首次登入後請改     │');
  console.log('└─────────────────────────────────────────────┘');
}

main()
  .catch((e) => {
    console.error('[seed] error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
