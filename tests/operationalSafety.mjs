// Configuration and maintenance tests with explicit in-memory transactions.
// No production secrets, external HTTP, real database, or SMTP is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'FixtureOperationalSecretWithEnoughEntropy_9283';
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
process.env.APP_BASE_URL = 'https://fixture.invalid';
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[key];
const { ConfigurationError, validateRuntimeConfig, getJwtSecret, validatePostgresUrl, validateOperatorPassword } = await import(root + '/src/lib/runtimeConfig.js');
const { DEMO_ORIGIN, DEMO_RESET_CONFIRMATION, requireDeploymentIdentity } = await import(root + '/src/lib/databaseIdentity.js');
const { prisma } = await import(root + '/src/lib/db.js');
const models = ['staff', 'case', 'hotel', 'requestUnit', 'meeting', 'meetingAttendee', 'vacation', 'businessTrip', 'shoot', 'changeLog', 'transferLog', 'notification', 'deploymentIdentity'];
let unexpectedGlobalAccess = 0;
for (const model of models) if (prisma[model]) {
  for (const method of ['count', 'findUnique', 'findFirst', 'findMany', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']) {
    prisma[model][method] = async () => { unexpectedGlobalAccess++; throw Error('Global Prisma access prohibited'); };
  }
}
for (const method of ['$connect', '$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe', '$transaction']) prisma[method] = async () => { unexpectedGlobalAccess++; throw Error('Live database access prohibited'); };
prisma.$disconnect = async () => {};
const { bootstrapDatabase } = await import(root + '/prisma/seed.js');
const { resetDemoDatabase } = await import(root + '/prisma/demo-seed.js');
const { JWT_SECRET, signToken } = await import(root + '/src/middleware/auth.js');
const production = () => ({ NODE_ENV: 'production', JWT_SECRET: process.env.JWT_SECRET, DATABASE_URL: process.env.DATABASE_URL, APP_BASE_URL: 'https://fixture.invalid', PORT: '3000' });
const instanceId = 'b40abfa5-265b-40ac-b4da-3392abc3861f';
const bootstrapEnv = () => ({ ...production(), BOOTSTRAP_EMPTY_DATABASE: 'yes', SEED_ADMIN_EMAIL: 'admin@fixture.invalid', SEED_ADMIN_PASSWORD: 'OperationalRose!4928' });
const demoEnv = () => ({ ...production(), APP_BASE_URL: DEMO_ORIGIN, DEMO_SEED: 'yes', DEMO_RESET_CONFIRM: DEMO_RESET_CONFIRMATION, DEMO_INSTANCE_ID: instanceId, DEMO_PASSWORD: 'SyntheticGarden!9284' });
const clone = value => structuredClone(value);
let state, operations, fault, commitFault, hashCalls, transactionOptions, txQueue;
function reset() {
  state = Object.fromEntries(models.map(model => [model, []]));
  operations = []; fault = ''; commitFault = false; hashCalls = []; transactionOptions = []; txQueue = Promise.resolve();
}
function populate() {
  for (const model of models.filter(m => m !== 'deploymentIdentity')) state[model].push({ id: model === 'case' ? 'OLD-CASE' : 99, fixture: 'existing-' + model });
  state.deploymentIdentity = [{ id: 1, environment: 'demo', instanceId, createdAt: new Date('2026-10-22') }];
}
const hashPassword = async (password, cost) => { hashCalls.push({ password, cost }); return 'synthetic-hash-for-fixture'; };
function adapter(getDatabase, inTransaction = false) {
  const client = {};
  for (const model of models) {
    client[model] = {};
    for (const method of ['count', 'findUnique', 'create', 'createMany', 'deleteMany', 'update', 'upsert']) {
      client[model][method] = async args => {
        const database = getDatabase();
        operations.push({ model, method, transaction: inTransaction });
        if (fault === model + '.' + method) throw Error('Synthetic operation failure');
        if (method === 'count') return database[model].length;
        if (method === 'findUnique') return clone(database[model].find(row => row.id === args.where.id) || null);
        assert(inTransaction, 'maintenance mutations must use the transaction client');
        assert.notEqual(model, 'deploymentIdentity', 'maintenance must never provision or mutate the database identity');
        if (method === 'deleteMany') { const count = database[model].length; database[model] = []; return { count }; }
        if (method === 'createMany') {
          for (const data of args.data) await client[model].create({ data });
          return { count: args.data.length };
        }
        if (method === 'create') {
          const data = clone(args.data), row = { id: database[model].reduce((max, item) => typeof item.id === 'number' ? Math.max(max, item.id) : max, 0) + 1, ...data };
          if (data.designer) { row.designerId = data.designer.connect.id; delete row.designer; }
          if (data.collaborators) row.collaborators = clone(data.collaborators.connect);
          if (data.createdBy) { row.createdById = data.createdBy.connect.id; delete row.createdBy; }
          if (data.attendees) {
            for (const attendee of data.attendees.create) database.meetingAttendee.push({ id: database.meetingAttendee.length + 1, meetingId: row.id, ...attendee });
            delete row.attendees;
          }
          database[model].push(row); return clone(row);
        }
        throw Error('Unexpected fixture mutation ' + model + '.' + method);
      };
    }
  }
  return client;
}
const client = adapter(() => state);
client.$transaction = (fn, options) => {
  const result = txQueue.then(async () => {
    transactionOptions.push(options);
    const database = clone(state);
    const result = await fn(adapter(() => database, true));
    if (commitFault) throw Object.assign(Error('Synthetic serializable commit conflict'), { code: 'P2034' });
    state = database; return result;
  });
  txQueue = result.catch(() => {}); return result;
};
const writes = () => operations.filter(op => !['count', 'findUnique'].includes(op.method));
const bootstrap = (env = bootstrapEnv(), extra = {}) => bootstrapDatabase(client, { env, hashPassword, now: new Date('2026-11-01T16:30:00Z'), ...extra });
const demoReset = (env = demoEnv(), extra = {}) => resetDemoDatabase(client, { env, hashPassword, now: new Date('2026-11-01T16:30:00Z'), ...extra });
let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS ' + name); }
await test('production config preserves the supplied secret and validates PostgreSQL origin and port', () => {
  const input = production(), config = validateRuntimeConfig(input);
  assert.equal(config.jwtSecret, input.JWT_SECRET); assert.equal(config.databaseUrl, input.DATABASE_URL); assert.equal(config.port, 3000); assert(Object.isFrozen(config));
  assert.equal(validatePostgresUrl('postgres://fixture@localhost/database?schema=public'), 'postgres://fixture@localhost/database?schema=public');
});
await test('production refuses missing short padded and known placeholder JWT secrets', () => {
  for (const JWT_SECRET of [undefined, '', 'short', 'change-me-in-prod', 'replace-me-with-a-long-random-secret-value', ' padded-secret-that-is-long-enough-for-production ']) {
    assert.throws(() => validateRuntimeConfig({ ...production(), JWT_SECRET }), error => error instanceof ConfigurationError && error.field === 'JWT_SECRET');
  }
});
await test('database configuration rejects wrong schemes missing names and malformed credentials without echoing values', () => {
  for (const DATABASE_URL of [undefined, '', 'mysql://fixture:PrivateValue@localhost/db', 'postgresql://localhost/', 'postgresql://fixture:PrivateValue@/db', 'postgresql://localhost/db#fragment']) {
    assert.throws(() => validateRuntimeConfig({ ...production(), DATABASE_URL }), error => error.field === 'DATABASE_URL' && !error.message.includes('PrivateValue'));
  }
});
await test('production origin rejects HTTP credentials paths query fragments loopback and absence', () => {
  for (const APP_BASE_URL of [undefined, 'http://fixture.invalid', 'https://user:PrivateValue@fixture.invalid', 'https://fixture.invalid/path', 'https://fixture.invalid?token=PrivateValue', 'https://fixture.invalid/#fragment', 'https://localhost', 'https://127.0.0.1']) {
    assert.throws(() => validateRuntimeConfig({ ...production(), APP_BASE_URL }), error => error.field === 'APP_BASE_URL' && !error.message.includes('PrivateValue'));
  }
});
await test('ports are validated before a listener can be opened', () => {
  for (const PORT of ['', '0', '-1', '65536', '3000abc', ' 3000', '1.5']) assert.throws(() => validateRuntimeConfig({ ...production(), PORT }), error => error.field === 'PORT');
  assert.equal(validateRuntimeConfig({ ...production(), PORT: '65535' }).port, 65535);
});
await test('development and tests retain explicit fixture secrets and allow local HTTP origins', () => {
  assert.equal(validateRuntimeConfig({ NODE_ENV: 'test', JWT_SECRET: 'fixture-short', APP_BASE_URL: 'http://localhost:3000' }).jwtSecret, 'fixture-short');
  assert.equal(validateRuntimeConfig({ NODE_ENV: 'development' }).port, 3000);
  assert(getJwtSecret({ NODE_ENV: 'development' }));
});
await test('misspelled environment modes cannot bypass production configuration checks', () => {
  for (const NODE_ENV of ['Production', 'production ', 'prod', 'staging', '']) assert.throws(() => validateRuntimeConfig({ ...production(), NODE_ENV }), error => error.field === 'NODE_ENV');
});
await test('auth uses the shared validated secret and valid fixture tokens still issue', () => {
  assert.equal(JWT_SECRET, getJwtSecret()); assert.equal(signToken({ id: 1 }).split('.').length, 3);
  const source = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  assert.match(source, /import \{ JWT_SECRET \} from '\.\/middleware\/auth\.js'/);
  assert(!source.includes("process.env.JWT_SECRET ||"));
});
await test('unsafe production startup exits before database methods listeners or credentials appear in diagnostics', () => {
  const probe = `import http from 'node:http';
http.Server.prototype.listen = function(){ console.error('BLOCKED_LISTENER'); throw Error('listener called before validation'); };
const {prisma}=await import('./src/lib/db.js');
for(const model of ['staff','case','meeting'])for(const method of ['findUnique','findMany','create','count'])prisma[model][method]=async()=>{console.error('BLOCKED_DATABASE');throw Error('database called before validation');};
prisma.$connect=async()=>{console.error('BLOCKED_DATABASE');throw Error('database connection prohibited');};
await import('./src/index.js');`;
  for (const overrides of [{ JWT_SECRET: '' }, { DATABASE_URL: 'mysql://fixture:DoNotPrintValue@localhost/database' }, { APP_BASE_URL: 'https://fixture.invalid/unsafe' }, { PORT: '0' }]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, env: { ...process.env, ...production(), ...overrides, DOTENV_CONFIG_PATH: '/tmp/design-pm-does-not-exist.env' }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(child.status, 0); assert.equal(child.signal, null); const output = child.stdout + child.stderr;
    assert.match(output, /ConfigurationError/); assert(!output.includes('BLOCKED_LISTENER')); assert(!output.includes('BLOCKED_DATABASE')); assert(!output.includes('DoNotPrintValue'));
  }
});
await test('importing maintenance scripts never starts a bootstrap reset or global Prisma operation', () => {
  assert.equal(unexpectedGlobalAccess, 0);
});
await test('existing installations skip bootstrap without credentials or dictionary resurrection', async () => {
  state.staff = [{ id: 1, name: 'Existing administrator' }]; state.hotel = [{ id: 1, name: 'Renamed hotel', sortOrder: 999 }];
  const before = clone(state); const result = await bootstrap(production());
  assert.equal(result.skipped, true); assert.deepEqual(state, before); assert.equal(writes().length, 0); assert.equal(hashCalls.length, 0); assert.equal(operations.length, 1);
});
await test('partial business data without staff also blocks bootstrap without altering dictionaries', async () => {
  state.hotel = [{ id: 1, name: 'Existing dictionary' }]; const before = clone(state);
  assert.equal((await bootstrap(production())).skipped, true); assert.deepEqual(state, before); assert.equal(writes().length, 0); assert.equal(hashCalls.length, 0);
});
await test('empty database bootstrap requires the explicit operator flag', async () => {
  const env = bootstrapEnv(); delete env.BOOTSTRAP_EMPTY_DATABASE;
  await assert.rejects(bootstrap(env), error => error.field === 'BOOTSTRAP_EMPTY_DATABASE'); assert.equal(writes().length, 0); assert.equal(hashCalls.length, 0);
});
await test('bootstrap requires an explicit email and refuses missing weak or shared sample passwords', async () => {
  for (const overrides of [{ SEED_ADMIN_EMAIL: undefined }, { SEED_ADMIN_EMAIL: 'invalid' }, { SEED_ADMIN_PASSWORD: undefined }, { SEED_ADMIN_PASSWORD: 'short' }, { SEED_ADMIN_PASSWORD: 'Demo2026test' }, { SEED_ADMIN_PASSWORD: 'Password!12345678' }]) {
    await assert.rejects(bootstrap({ ...bootstrapEnv(), ...overrides }), error => error instanceof ConfigurationError); assert.equal(writes().length, 0);
  }
  assert.equal(hashCalls.length, 0);
});
await test('maintenance password validation respects the bcrypt UTF-8 limit', () => {
  assert.throws(() => validateOperatorPassword('漢'.repeat(25) + 'Abc123'), error => error.field === 'SEED_ADMIN_PASSWORD');
  assert.equal(validateOperatorPassword('SyntheticGarden!9284'), 'SyntheticGarden!9284');
});
await test('bootstrap atomically creates one administrator dictionaries and no sample cases', async () => {
  state.deploymentIdentity = [{ id: 1, environment: 'production', instanceId }]; const identity = clone(state.deploymentIdentity);
  const result = await bootstrap(); assert.equal(result.staff, 1); assert.equal(result.cases, 0);
  assert.equal(state.staff.length, 1); assert.equal(state.staff[0].name, 'Administrator'); assert.equal(state.staff[0].email, 'admin@fixture.invalid');
  assert.equal(state.staff[0].role, 'admin'); assert.equal(state.staff[0].pendingActivation, false); assert.equal(state.staff[0].password, 'synthetic-hash-for-fixture');
  assert.equal(state.staff[0].joined.toISOString().slice(0, 10), '2026-11-02'); assert.equal(state.hotel.length, 10); assert.equal(state.requestUnit.length, 11); assert.equal(state.case.length, 0);
  assert.deepEqual(state.deploymentIdentity, identity); assert.equal(hashCalls[0].cost, 12); assert.equal(transactionOptions[0].isolationLevel, 'Serializable');
});
await test('bootstrap failure after dictionary insertion rolls back every initialized record', async () => {
  const before = clone(state); fault = 'staff.create'; await assert.rejects(bootstrap()); assert.deepEqual(state, before);
});
await test('bootstrap serializable commit conflict leaves no partial administrator or dictionary data', async () => {
  const before = clone(state); commitFault = true; await assert.rejects(bootstrap(), error => error instanceof ConfigurationError && /changed during bootstrap/.test(error.message)); assert.deepEqual(state, before);
});
await test('a database populated while password hashing runs is rechecked before any bootstrap write', async () => {
  const result = await bootstrap(bootstrapEnv(), { hashPassword: async () => { state.staff.push({ id: 42, name: 'Concurrent admin' }); return 'synthetic-hash'; } });
  assert.equal(result.skipped, true); assert.equal(state.staff.length, 1); assert.equal(state.hotel.length, 0); assert.equal(writes().length, 0);
});
await test('concurrent bootstrap attempts create only one administrator', async () => {
  let readers = 0, release; const waiting = new Promise(resolve => { release = resolve; });
  const hashing = async () => { if (++readers === 2) release(); await waiting; return 'synthetic-hash'; };
  const results = await Promise.all([bootstrap(bootstrapEnv(), { hashPassword: hashing }), bootstrap(bootstrapEnv(), { hashPassword: hashing })]);
  assert.deepEqual(results.map(r => r.skipped).sort(), [false, true]); assert.equal(state.staff.length, 1); assert.equal(state.hotel.length, 10); assert.equal(state.requestUnit.length, 11);
});
await test('Demo reset requires exact origin both confirmation fields and an independently supplied instance UUID', async () => {
  for (const overrides of [{ DEMO_SEED: undefined }, { DEMO_RESET_CONFIRM: undefined }, { DEMO_RESET_CONFIRM: 'yes' }, { APP_BASE_URL: 'https://fixture.invalid' }, { APP_BASE_URL: DEMO_ORIGIN + '/' }, { DEMO_INSTANCE_ID: undefined }, { DEMO_INSTANCE_ID: 'not-a-uuid' }]) {
    reset(); populate(); const before = clone(state);
    await assert.rejects(demoReset({ ...demoEnv(), ...overrides }), error => error instanceof ConfigurationError);
    assert.deepEqual(state, before); assert.equal(writes().length, 0); assert.equal(hashCalls.length, 0); assert.equal(operations.length, 0);
  }
});
await test('Demo reset cannot use a missing weak or default password even for a matching target', async () => {
  populate(); const before = clone(state);
  for (const DEMO_PASSWORD of [undefined, '', 'Demo2026test', 'passwordABC123']) await assert.rejects(demoReset({ ...demoEnv(), DEMO_PASSWORD }), error => error.field === 'DEMO_PASSWORD');
  assert.deepEqual(state, before); assert.equal(writes().length, 0); assert.equal(hashCalls.length, 0); assert.equal(operations.length, 0);
});
await test('missing production or mismatched database identity rejects reset before hashing or deleting', async () => {
  for (const identity of [[], [{ id: 1, environment: 'production', instanceId }], [{ id: 1, environment: 'demo', instanceId: 'bb91beca-f8bd-4394-9658-538609db9992' }]]) {
    reset(); populate(); state.deploymentIdentity = identity; const before = clone(state);
    await assert.rejects(demoReset(), error => error.code === 'deployment_identity_mismatch'); assert.deepEqual(state, before); assert.equal(writes().length, 0); assert.equal(hashCalls.length, 0);
  }
});
await test('missing identity metadata fails closed with a migration and provisioning instruction', async () => {
  populate(); fault = 'deploymentIdentity.findUnique'; const before = clone(state);
  await assert.rejects(demoReset(), error => error.code === 'deployment_identity_unavailable' && /migration.*provision/.test(error.message)); assert.deepEqual(state, before); assert.equal(writes().length, 0);
});
await test('identity environment and UUID arguments are validated without database access', async () => {
  await assert.rejects(requireDeploymentIdentity(client, { environment: 'unknown', instanceId }), error => error.code === 'invalid_deployment_identity');
  await assert.rejects(requireDeploymentIdentity(client, { environment: 'demo', instanceId: 'bad' }), error => error.code === 'invalid_deployment_identity'); assert.equal(operations.length, 0);
});
await test('identity verification accepts the independently provisioned restore environment', async () => {
  state.deploymentIdentity = [{ id: 1, environment: 'restore', instanceId }];
  assert.equal((await requireDeploymentIdentity(client, { environment: 'restore', instanceId })).environment, 'restore');
  assert.equal(writes().length, 0);
});
await test('identity is rechecked in the destructive transaction after hashing', async () => {
  populate(); const business = clone(state.staff);
  await assert.rejects(demoReset(demoEnv(), { hashPassword: async () => { state.deploymentIdentity[0].environment = 'production'; return 'synthetic-hash'; } }), error => error.code === 'deployment_identity_mismatch');
  assert.equal(state.deploymentIdentity[0].environment, 'production'); assert.deepEqual(state.staff, business); assert.equal(writes().length, 0); assert.equal(transactionOptions.length, 1);
});
await test('Demo wipe failure rolls back all earlier deletions and preserves the identity', async () => {
  populate(); const before = clone(state); fault = 'staff.deleteMany'; await assert.rejects(demoReset()); assert.deepEqual(state, before);
});
await test('Demo reseed failure restores the entire original database rather than leaving a wiped database', async () => {
  populate(); const before = clone(state); fault = 'case.create'; await assert.rejects(demoReset()); assert.deepEqual(state, before);
});
await test('Demo reset serializable commit failure rolls back the complete batch', async () => {
  populate(); const before = clone(state); commitFault = true; await assert.rejects(demoReset(), error => error.code === 'P2034'); assert.deepEqual(state, before);
});
await test('successful Demo reset preserves identity and commits only synthetic internally consistent records', async () => {
  populate(); const identity = clone(state.deploymentIdentity); const result = await demoReset();
  assert.deepEqual(result, { staff: 4, cases: 5, meetings: 2, schedules: 3 }); assert.deepEqual(state.deploymentIdentity, identity);
  assert.equal(state.staff.length, 4); assert(state.staff.every(p => p.name.startsWith('test_') && p.email.endsWith('@demo.local') && p.password === 'synthetic-hash-for-fixture'));
  assert.equal(state.case.length, 5); assert.equal(state.meeting.length, 2); assert.equal(state.businessTrip.length + state.vacation.length + state.shoot.length, 3);
  assert.equal(state.hotel.length, 5); assert.equal(state.requestUnit.length, 5); assert.equal(state.notification.length, 0);
  const people = new Set(state.staff.map(p => p.id)); for (const record of state.case) { assert(people.has(record.designerId)); for (const co of record.collaborators) assert(people.has(co.id)); }
  const log = state.case[0].logs[0]; assert(log.note); assert(log.by); assert.equal(log.text, undefined); assert.equal(log.author, undefined);
  assert.equal(transactionOptions[0].isolationLevel, 'Serializable'); assert(operations.filter(op => op.model === 'deploymentIdentity').every(op => op.method === 'findUnique'));
});
await test('maintenance entrypoints do not emit supplied passwords connection URLs or secrets', async () => {
  const seen = [], old = console.log; console.log = (...args) => seen.push(args.join(' '));
  try { await bootstrap(); reset(); populate(); await demoReset(); } finally { console.log = old; }
  const output = seen.join('\n'); assert(!output.includes(bootstrapEnv().SEED_ADMIN_PASSWORD)); assert(!output.includes(demoEnv().DEMO_PASSWORD)); assert(!output.includes(process.env.JWT_SECRET)); assert(!output.includes(process.env.DATABASE_URL));
});
await test('the actual Demo CLI rejects missing confirmation before database access and never prints credentials', () => {
  const env = { ...process.env, ...demoEnv(), DEMO_RESET_CONFIRM: '', DOTENV_CONFIG_PATH: '/tmp/design-pm-does-not-exist.env' };
  const child = spawnSync(process.execPath, ['prisma/demo-seed.js'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1); assert.equal(child.signal, null); const output = child.stdout + child.stderr;
  assert.match(output, /DEMO_RESET_CONFIRM/); assert(!output.includes(env.DEMO_PASSWORD)); assert(!output.includes(env.JWT_SECRET)); assert(!output.includes(env.DATABASE_URL));
});
assert.equal(unexpectedGlobalAccess, 0);
await prisma.$disconnect();
console.log(JSON.stringify({ passed, liveDatabase: false, emailsSent: 0, provisionedIdentity: false }));
