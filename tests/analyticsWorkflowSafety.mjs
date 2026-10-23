// Actual analytics/workload services with synthetic records only. No network or DB.
import assert from 'node:assert/strict';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/never_connect';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const { prisma } = await import(root + '/src/lib/db.js');
const { resolvePeriod, rollup, taipeiCalendarDay } = await import(root + '/src/services/analytics.js');
const { workloadScore, workloadForAll, suggestSuccessor } = await import(root + '/src/services/workload.js');
for (const method of ['$connect', '$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe']) {
  prisma[method] = async () => { throw Error('Live DB access blocked'); };
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const day = s => new Date(s + 'T00:00:00Z');
const person = (id, overrides = {}) => ({ id, name: 'Fixture ' + id, role: 'member', seniority: 'mid', active: true, pendingActivation: false, ...overrides });
let staff = [], cases = [], work = [], completed = [], mode = 'workload';
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'NOT') return !matches(row, value);
    if (key === 'collaborators') return row.collaborators.some(p => matches(p, value.some));
    if (typeof value !== 'object' || value === null) return row[key] === value;
    return Object.entries(value).every(([op, val]) => {
      if (op === 'in') return val.includes(row[key]);
      if (op === 'notIn') return !val.includes(row[key]);
      throw Error('Unhandled fixture predicate ' + op);
    });
  });
}
prisma.staff.findMany = async args => structuredClone(staff.filter(s => matches(s, args?.where)));
prisma.case.findMany = async args => {
  if (mode === 'analytics') return structuredClone(args.where.status?.in ? completed : work);
  return structuredClone(cases.filter(c => matches(c, args.where)));
};

for (const [reference, label, start] of [
  ['2018-12-31', '2019 W01', '2018-12-31'],
  ['2021-01-01', '2020 W53', '2020-12-28'],
  ['2020-12-31', '2020 W53', '2020-12-28'],
  ['2022-01-01', '2021 W52', '2021-12-27'],
  ['2026-10-22', '2026 W43', '2026-10-19'],
]) await check('ISO week label and seven-day window at ' + reference, () => {
  const result = resolvePeriod('week', 0, day(reference));
  assert.equal(result.label, label); assert.equal(+result.start, +day(start));
  assert.equal(result.end - result.start, 7 * 86400000);
});
await check('ISO week offset crosses year using target week year', () => {
  const result = resolvePeriod('week', -1, day('2021-01-04'));
  assert.equal(result.label, '2020 W53'); assert.equal(+result.start, +day('2020-12-28'));
});
await check('Taipei day advances at local midnight', () => {
  assert.equal(+taipeiCalendarDay(new Date('2026-10-21T16:01:00Z')), +day('2026-10-22'));
});

mode = 'analytics';
staff = [person(1), person(2), person(3, { active: false })];
const sample = { id: 'D-2026-10-001', title: 'Fixture legacy transfer', level: 'A', status: 'done', archived: false,
  designerId: 1, designer: { id: 1, name: 'Fixture 1' }, hotel: 'Fixture hall',
  dispatchDate: day('2026-09-01'), closedOn: day('2026-10-20'), goLiveDate: day('2026-10-20'),
  collaborators: [{ id: 1, name: 'Fixture 1' }, { id: 2, name: 'Fixture 2' }, { id: 2, name: 'Fixture 2 duplicate' }, { id: 3, name: 'Former fixture 3' }],
};
completed = [sample]; work = [sample];
const before = structuredClone(sample);
const analytics = await rollup({ period: 'year', offset: 0 });
await check('legacy primary collaborator receives exactly primary credit', () => {
  const owner = analytics.perStaff.find(p => p.staffId === 1);
  assert.equal(owner.primary.count, 1); assert.equal(owner.collab.count, 0);
  assert.equal(owner.totalScore, 3.3);
});
await check('duplicate legacy collaborator receives one contribution', () => {
  const co = analytics.perStaff.find(p => p.staffId === 2);
  assert.equal(co.collab.count, 1); assert.equal(co.totalScore, 1.32); assert.equal(co.totalCount, 0);
});
await check('departed collaborator historical contribution remains visible', () => {
  const former = analytics.perStaff.find(p => p.staffId === 3);
  assert.equal(former.active, false); assert.equal(former.collab.count, 1); assert.equal(former.totalScore, 1.32);
});
await check('department score and case count remain primary basis', () => {
  assert.equal(analytics.totals.count, 1); assert.equal(analytics.totals.score, 3.3);
});
await check('case list and work ledger show each collaborator once, excluding owner', () => {
  assert.deepEqual(analytics.cases[0].collaboratorNames, ['Fixture 2', 'Former fixture 3']);
  assert.deepEqual(analytics.workCases[0].collaborators.map(p => p.id), [2, 3]);
});
await check('rollup does not mutate source participation history', () => assert.deepEqual(sample, before));
completed = [{ ...sample, collaborators: [] }]; work = completed;
await check('case without collaborators retains normal completed and ledger output', async () => {
  const r = await rollup({ period: 'year', offset: 0 });
  assert.deepEqual(r.cases[0].collaboratorNames, []); assert.deepEqual(r.workCases[0].collaborators, []);
});

mode = 'workload';
const assignment = (id, designerId, level, status, collaborators = [], archived = false) => ({ id, designerId, level, status, collaborators: collaborators.map(id => ({ id })), archived });
cases = [assignment('own', 1, 'A', 'doing', [1]), assignment('co', 2, 'S', 'review', [1]),
  assignment('cancel-own', 1, 'SS', 'cancelled'), assignment('cancel-co', 2, 'SS', 'cancelled', [1]),
  assignment('done', 1, 'SS', 'done'), assignment('closed-co', 2, 'SS', 'closed', [1]),
  assignment('archived', 1, 'SS', 'doing', [], true)];
await check('workload excludes cancelled, ended and archived cases; primary not double-counted', async () => {
  assert.equal(await workloadScore(1), 4.6);
});
staff = [person(1), person(2, { role: 'observer' }), person(3, { pendingActivation: true }),
  person(4, { active: false }), person(5, { role: 'admin', seniority: 'senior' }), person(6, { seniority: 'junior' })];
cases = [];
await check('successor candidates exclude leaver, inactive, observers and pending invitations', async () => {
  const candidate = await suggestSuccessor({ excludeId: 1, level: 'SS' });
  assert.equal(candidate.id, 5);
  const candidates = await workloadForAll({ excludeId: 1, assignableOnly: true });
  assert.deepEqual(candidates.map(s => s.id), [5, 6]);
});
await check('default workload dashboard retains every active staff role', async () => {
  assert.deepEqual((await workloadForAll()).map(s => s.id), [1, 2, 3, 5, 6]);
});
staff = [person(1), person(2, { role: 'observer' }), person(3, { pendingActivation: true })];
await check('no eligible successor returns null', async () => assert.equal(await suggestSuccessor({ excludeId: 1, level: 'A' }), null));
await prisma.$disconnect();
console.log(`\n${passed}/${passed} analytics/workload regression tests passed`);
