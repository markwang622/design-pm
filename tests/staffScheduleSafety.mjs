// Actual route/service regression tests using synthetic records and a blocked,
// rollback-capable in-memory Prisma adapter. No live DB, SMTP or remote HTTP.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const express = require('express'), cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-staff-schedule-test-secret-only';
process.env.APP_BASE_URL = 'https://fixture.invalid';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/never_connect';
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[key];
// Avoid password work or mail in this fixture; hashing is not what this suite proves.
let hashHook = async password => 'synthetic-hash:' + password;
bcrypt.hash = (...args) => hashHook(...args);
const { prisma } = await import(root + '/src/lib/db.js');
const { signToken } = await import(root + '/src/middleware/auth.js');
const { hashToken } = await import(root + '/src/lib/activation.js');
const { checkMeetingReminders } = await import(root + '/src/services/meetingReminders.js');

const day = s => new Date(s + 'T00:00:00Z');
const terminal = ['done', 'closed', 'cancelled'];
function person(id, overrides = {}) {
  return { id, name: 'Fixture ' + id, email: `fixture-${id}@example.invalid`, role: id === 1 ? 'admin' : 'member',
    active: true, pendingActivation: false, sessionVersion: 0, joined: day('2025-01-01'),
    seniority: 'mid', password: 'synthetic-original-hash', activationTokenHash: null, activationExpires: null, ...overrides };
}
let state, txCount, writes, transactionOptions, failTransfer, failNotificationAt, notificationAttempts, failMarker, commitFailures, beforeMeetingDelete, lookupBarrier, scheduleLookupBarrier, renameConflictCaseId, caseListReads;
function reset() {
  state = { staff: [person(1), person(2), person(3), person(4)], case: [], transferLog: [], notification: [], meeting: [], vacation: [], businessTrip: [], shoot: [] };
  txCount = writes = notificationAttempts = commitFailures = caseListReads = 0; transactionOptions = [];
  failTransfer = failMarker = false; failNotificationAt = null; beforeMeetingDelete = lookupBarrier = scheduleLookupBarrier = renameConflictCaseId = null;
  hashHook = async password => 'synthetic-hash:' + password;
}
function matches(row, where = {}) {
  return Object.entries(where).every(([key, wanted]) => {
    if (wanted === undefined) return true;
    if (key === 'NOT') return !matches(row, wanted);
    if (key === 'AND') return wanted.every(w => matches(row, w));
    if (key === 'OR') return wanted.some(w => matches(row, w));
    if (key === 'collaborators') return row.collaborators.some(p => matches(p, wanted.some));
    const got = row[key];
    if (wanted === null) return got == null;
    if (typeof wanted !== 'object' || wanted instanceof Date) return got instanceof Date ? +got === +wanted : got === wanted;
    return Object.entries(wanted).every(([op, val]) => {
      if (op === 'in') return val.includes(got);
      if (op === 'notIn') return !val.includes(got);
      if (op === 'not') return got !== val;
      if (op === 'gt') return got != null && got > val;
      if (op === 'gte') return got != null && got >= val;
      if (op === 'lte') return got != null && got <= val;
      throw Error('Unsupported fixture predicate ' + op);
    });
  });
}
function apply(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (key === 'designer') row.designerId = value.connect.id;
    else if (key === 'collaborators') row.collaborators = row.collaborators.filter(p => p.id !== value.disconnect.id);
    else if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment;
    else row[key] = structuredClone(value);
  }
}
function adapter(getState, inTx) {
  const db = {};
  for (const model of Object.keys(state)) {
    db[model] = {};
    for (const method of ['findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany', 'deleteMany', 'delete']) {
      db[model][method] = async args => {
        const rows = getState()[model];
        if (method === 'findUnique' || method === 'findFirst') {
          const found = rows.find(r => matches(r, args.where));
          const copy = found ? structuredClone(found) : null;
          if (model === 'staff' && method === 'findFirst' && !inTx && lookupBarrier) await lookupBarrier();
          if (scheduleLookupBarrier?.model === model && method === 'findUnique' && !inTx) await scheduleLookupBarrier.wait();
          return copy;
        }
        if (method === 'findMany') { if(model==='case')caseListReads++; return structuredClone(rows.filter(r => matches(r, args?.where))); }
        if (['case', 'transferLog', 'meeting'].includes(model) || (model === 'notification' && args.data?.type === 'meetingReminder')) assert(inTx || (model==='case' && method==='updateMany'), model + ' write must use the transaction client');
        if (model==='case' && method==='updateMany' && args.data.items && args.where.id===renameConflictCaseId) return {count:0};
        if (model === 'transferLog' && failTransfer) throw Error('synthetic transfer log failure');
        if (model === 'notification' && ++notificationAttempts === failNotificationAt) throw Error('synthetic notification insertion failure');
        if (model === 'meeting' && method === 'update' && args.data.remindedAt && failMarker) throw Error('synthetic reminder marker failure');
        writes++;
        if (method === 'create') {
          const row = { id: rows.length + 1, ...structuredClone(args.data) }; rows.push(row); return structuredClone(row);
        }
        if (model === 'meeting' && method === 'deleteMany' && beforeMeetingDelete) beforeMeetingDelete();
        const selected = rows.filter(r => matches(r, args.where));
        if (method === 'update' || method === 'updateMany') {
          if (method === 'update' && !selected.length) throw Object.assign(Error('not_found'), { code: 'P2025' });
          for (const row of selected) apply(row, args.data);
          return method === 'updateMany' ? { count: selected.length } : structuredClone(selected[0]);
        }
        if (method === 'delete' || method === 'deleteMany') {
          getState()[model] = rows.filter(r => !selected.includes(r));
          return method === 'deleteMany' ? { count: selected.length } : selected[0];
        }
        throw Error('Unhandled fixture access: ' + model + '.' + method);
      };
    }
  }
  return db;
}
reset();
// Any unexpected method on the real client is blocked rather than reaching Prisma.
for (const model of Object.keys(state).concat('meetingAttendee', 'emailToken')) {
  if (!prisma[model]) continue;
  for (const method of ['findUnique','findFirst','findMany','create','createMany','update','updateMany','delete','deleteMany','count','aggregate','upsert']) {
    prisma[model][method] = async () => { throw Error('Unexpected Prisma access blocked: ' + model + '.' + method); };
  }
}
const outside = adapter(() => state, false);
for (const [model, methods] of Object.entries(outside)) Object.assign(prisma[model], methods);
let queue = Promise.resolve();
prisma.$transaction = (fn, options) => {
  const next = queue.then(async () => {
    txCount++; transactionOptions.push(options);
    const copy = structuredClone(state);
    const result = await fn(adapter(() => copy, true));
    if (commitFailures > 0) { commitFailures--; throw Object.assign(Error('synthetic serializable commit conflict'), {code:'P2034'}); }
    state = copy;
    return result;
  });
  queue = next.catch(() => {});
  return next;
};
for (const method of ['$connect', '$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe']) prisma[method] = async () => { throw Error('Live DB access blocked'); };

const app = express();
app.use(express.json(), cookieParser());
for (const [path, file] of [['auth','auth'],['staff','staff'],['cases','cases'],['vacations','vacations'],['business-trips','businessTrips'],['shoots','shoots'],['meetings','meetings']]) {
  app.use('/api/' + path, (await import(root + '/src/routes/' + file + '.js')).default);
}
app.use((e, _req, res, _next) => res.status(500).json({ error: 'synthetic_handler_failure', message: e.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const cookie = (id = 1, sessionVersion = 0) => 'designpm_token=' + signToken({ id, sessionVersion });
async function call(path, { method = 'GET', body, user = 1, authCookie } = {}) {
  const response = await fetch(base + '/api' + path, { method, headers: { ...(user == null ? {} : { Cookie: authCookie || cookie(user) }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
}
const work = (id, overrides = {}) => ({ id, title: id, status: 'doing', archived: false, designerId: 2, collaborators: [], level: 'A', ...overrides });
const departure = successors => call('/staff/2/departure', { method: 'POST', body: { successors } });
let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS ' + name); }
try {
  const assignmentCase=(id,items,extra={})=>work(id,{designerId:3,items,contentVersion:0,updatedAt:new Date('2026-10-01T00:00:00Z'),logs:[{note:'Fixture 2 wrote this historical log',by:'Fixture 2'}],...extra});
  await test('self rename durably preserves legacy subitems on another persons case after fresh API reads', async () => {
    state.case=[assignmentCase('OTHER',[{n:'Legacy assignment',type:'Fixture',owner:'Fixture 2',logs:[{by:'Fixture 2',note:'Historical subitem log'}],custom:'preserved'}])];
    const history=structuredClone(state.case[0].logs),nestedHistory=structuredClone(state.case[0].items[0].logs);
    const r=await call('/staff/2',{method:'PATCH',body:{name:'Renamed Fixture 2'},user:2});assert.equal(r.status,200,JSON.stringify(r));
    const fresh=await call('/cases/OTHER',{user:2});assert.equal(fresh.status,200);assert.equal(fresh.data.designerId,3);
    assert.equal(fresh.data.items[0].assigneeId,2);assert.equal(fresh.data.items[0].owner,'Renamed Fixture 2');assert.equal(fresh.data.items[0].custom,'preserved');
    assert.deepEqual(fresh.data.logs,history);assert.deepEqual(fresh.data.items[0].logs,nestedHistory);assert.equal(fresh.data.contentVersion,1);
    assert(new Date(fresh.data.updatedAt)>new Date('2026-10-01T00:00:00Z'));assert.equal(transactionOptions[0].isolationLevel,'Serializable');
    assert.equal((await call('/auth/me',{user:2})).data.name,'Renamed Fixture 2');
  });
  await test('admin rename refreshes ID labels and legacy null assignments without stealing another ID or changing history', async () => {
    const untouched=[{n:'Other ID',assigneeId:4,owner:'Fixture 2'},{n:'Other legacy',owner:'Fixture 4'},null,'opaque legacy entry'];
    state.case=[assignmentCase('MIXED',[{n:'By ID',assigneeId:2,owner:'Stale display label'},{n:'Legacy null',assigneeId:null,owner:'Fixture 2'},...untouched]),assignmentCase('UNRELATED',[{n:'Other',owner:'Fixture 4'}])];
    const history=structuredClone(state.case[0].logs),unrelated=structuredClone(state.case[1]);
    assert.equal((await call('/staff/2',{method:'PATCH',body:{name:'Admin Renamed Fixture 2'},user:1})).status,200);
    assert.deepEqual(state.case[0].items.slice(0,2),[{n:'By ID',assigneeId:2,owner:'Admin Renamed Fixture 2'},{n:'Legacy null',assigneeId:2,owner:'Admin Renamed Fixture 2'}]);
    assert.deepEqual(state.case[0].items.slice(2),untouched);assert.deepEqual(state.case[0].logs,history);assert.deepEqual(state.case[1],unrelated);assert.equal(state.case[0].contentVersion,1);
  });
  await test('unchanged staff names and ordinary profile patches leave case JSON and versions untouched', async () => {
    state.case=[assignmentCase('UNCHANGED',[{n:'Legacy',owner:'Fixture 2'}])];const before=structuredClone(state.case);
    assert.equal((await call('/staff/2',{method:'PATCH',body:{name:'Fixture 2',roleTitle:'Updated title'},user:2})).status,200);
    assert.deepEqual(state.case,before);assert.equal(caseListReads,0);
    assert.equal((await call('/staff/2',{method:'PATCH',body:{color:'teal'},user:2})).status,200);assert.deepEqual(state.case,before);assert.equal(caseListReads,0);
  });
  await test('rename normalizes same-ID numeric strings without claiming empty malformed or other IDs', async () => {
    const untouched=[{n:'Other string ID',assigneeId:'4',owner:'Fixture 2'},{n:'Empty ID',assigneeId:'',owner:'Fixture 2'},{n:'Whitespace ID',assigneeId:'  ',owner:'Fixture 2'},{n:'Malformed ID',assigneeId:'2invalid',owner:'Fixture 2'},{n:'Boolean ID',assigneeId:true,owner:'Fixture 2'},{n:'Unassigned',assigneeId:null,owner:''}];
    state.case=[assignmentCase('STRING-ID',[{n:'Numeric string',assigneeId:'2',owner:'Stale label'},...untouched])];
    assert.equal((await call('/staff/2',{method:'PATCH',body:{name:'Numeric ID Rename'},user:2})).status,200);
    const fresh=await call('/cases/STRING-ID',{user:2});assert.equal(fresh.status,200);
    assert.deepEqual(fresh.data.items[0],{n:'Numeric string',assigneeId:2,owner:'Numeric ID Rename'});
    assert.deepEqual(fresh.data.items.slice(1),untouched);assert.equal(fresh.data.contentVersion,1);
  });
  await test('rename case CAS conflict rolls back staff name and every previously updated case', async () => {
    state.case=[assignmentCase('FIRST',[{n:'Legacy',owner:'Fixture 2'}]),assignmentCase('SECOND',[{n:'ID',owner:'Fixture 2',assigneeId:2}])];
    const before=structuredClone(state);renameConflictCaseId='SECOND';
    const r=await call('/staff/2',{method:'PATCH',body:{name:'Must Roll Back'},user:2});assert.equal(r.status,409);assert.equal(r.data.error,'staff_rename_conflict');assert.deepEqual(state,before);
    renameConflictCaseId=null;assert.equal((await call('/staff/2',{method:'PATCH',body:{name:'Retry Rename'},user:2})).status,200);assert(state.case.every(c=>c.items[0].assigneeId===2&&c.items[0].owner==='Retry Rename'));
  });
  await test('rename Serializable commit conflict rolls back staff and subitems and leaves retry eligible', async () => {
    state.case=[assignmentCase('CASE',[{n:'Legacy',owner:'Fixture 2'}])];const before=structuredClone(state);commitFailures=1;
    const r=await call('/staff/2',{method:'PATCH',body:{name:'Retry After Conflict'},user:1});assert.equal(r.status,409);assert.equal(r.data.error,'staff_rename_conflict');assert.deepEqual(state,before);
    assert.equal((await call('/staff/2',{method:'PATCH',body:{name:'Retry After Conflict'},user:1})).status,200);assert.equal(state.case[0].items[0].assigneeId,2);
  });
  await test('a stale subitems edit after rename cannot erase the new durable assignment', async () => {
    state.case=[assignmentCase('CASE',[{n:'Legacy',owner:'Fixture 2'}])];const before=structuredClone(state.case[0]);
    assert.equal((await call('/staff/2',{method:'PATCH',body:{name:'Preserved Name'},user:2})).status,200);
    const r=await call('/cases/CASE/items',{method:'PATCH',body:{items:before.items,expectedUpdatedAt:before.updatedAt.toISOString(),expectedContentVersion:before.contentVersion},user:3});
    assert.equal(r.status,409);assert.equal(r.data.error,'edit_conflict');assert.equal(state.case[0].items[0].assigneeId,2);assert.equal(state.case[0].items[0].owner,'Preserved Name');assert.equal(state.case[0].contentVersion,1);
  });
  await test('departure rejects self, missing, inactive, pending and observer successors with zero mutation', async () => {
    for (const [successorId, attributes] of [[2,{}],[0,{}],[999,{}],[3,{active:false}],[3,{pendingActivation:true}],[3,{role:'observer'}]]) {
      reset(); Object.assign(state.staff.find(p => p.id === 3), attributes);
      state.case = [work('OPEN'), work('DONE', { status: 'done' })];
      const before = structuredClone(state);
      const r = await departure({ OPEN: successorId });
      assert.equal(r.status, 422, JSON.stringify(r)); assert.equal(r.data.error, 'invalid_successor');
      assert.deepEqual(state, before); assert.equal(writes, 0); assert.equal(txCount, 1);
      assert.equal(transactionOptions[0].isolationLevel, 'Serializable');
    }
  });
  await test('departure validates every case before archiving or transferring any of them', async () => {
    state.case = [work('FIRST'), work('SECOND'), work('DONE', { status:'done' })];
    const before = structuredClone(state);
    assert.equal((await departure({ FIRST: 3, SECOND: 4 })).status, 200);
    reset(); state.case = structuredClone(before.case); state.staff.find(p => p.id === 4).active = false;
    const unchanged = structuredClone(state);
    assert.equal((await departure({ FIRST: 3, SECOND: 4 })).status, 422);
    assert.deepEqual(state, unchanged); assert.equal(writes, 0);
    assert.equal((await departure({ FIRST: 3 })).status, 400); assert.equal(writes, 0);
  });
  await test('departure rollback preserves assignments, archives, collaborator history and staff on audit failure', async () => {
    state.case = [work('OPEN'), work('DONE',{status:'done'}),work('COLLAB',{designerId:3,collaborators:[{id:2}]})];
    failTransfer = true; const before = structuredClone(state);
    assert.equal((await departure({ OPEN: 3 })).status, 500); assert.deepEqual(state, before);
  });
  await test('departure preserves terminal and archived participation; successor loses duplicate collaborator role', async () => {
    state.case = [work('OWN',{collaborators:[{id:3},{id:4}]}),work('ACTIVE',{designerId:3,collaborators:[{id:2}]})];
    for (const status of terminal) state.case.push(work('HISTORY-'+status,{designerId:3,status,collaborators:[{id:2}]}));
    state.case.push(work('ARCHIVED',{designerId:3,archived:true,collaborators:[{id:2}]}));
    state.case.push(work('OWN-CANCELLED',{status:'cancelled'}));
    const preview = await call('/staff/2/departure-preview');
    assert.equal(preview.status,200); assert.deepEqual(preview.data.toRemoveCollab.map(c=>c.id),['ACTIVE']);
    assert(preview.data.toArchive.some(c=>c.id==='OWN-CANCELLED'));
    const r = await departure({OWN:3}); assert.equal(r.status,200,JSON.stringify(r));
    assert.deepEqual(r.data.removedCollab,['ACTIVE']); assert.equal(state.staff.find(p=>p.id===2).active,false);
    assert.equal(state.case.find(c=>c.id==='OWN').designerId,3); assert.deepEqual(state.case.find(c=>c.id==='OWN').collaborators,[{id:4}]);
    for (const c of state.case.filter(c=>c.id.startsWith('HISTORY-')||c.id==='ARCHIVED')) assert.deepEqual(c.collaborators,[{id:2}]);
  });
  await test('series host cannot delete any occurrence unless authorized for every instance', async () => {
    state.meeting=[{id:9,seriesId:'fixture-series',hostId:3,createdById:2},{id:10,seriesId:'fixture-series',hostId:2,createdById:2}];
    const before=structuredClone(state.meeting);
    const r=await call('/meetings/9?series=1',{method:'DELETE',user:3});
    assert.equal(r.status,403); assert.deepEqual(state.meeting,before); assert.equal(writes,0); assert.equal(txCount,1);
  });
  await test('series creator, all-occurrence host and admin can atomically delete only the authorized IDs', async () => {
    for (const user of [1,2,3]) {
      reset(); state.meeting=[{id:9,seriesId:'S',hostId:3,createdById:2},{id:10,seriesId:'S',hostId:3,createdById:2},{id:11,seriesId:'OTHER',hostId:4,createdById:4}];
      const r=await call('/meetings/9?series=1',{method:'DELETE',user}); assert.equal(r.status,200); assert.equal(r.data.deleted,2);
      assert.deepEqual(state.meeting.map(m=>m.id),[11]); assert.equal(transactionOptions[0].isolationLevel,'Serializable');
    }
  });
  await test('series delete transaction conflict leaves all meetings intact', async () => {
    state.meeting=[{id:9,seriesId:'S',hostId:3,createdById:2},{id:10,seriesId:'S',hostId:3,createdById:2}];
    const before=structuredClone(state.meeting);
    beforeMeetingDelete=()=>{throw Object.assign(Error('synthetic serializable conflict'),{code:'P2034'});};
    assert.equal((await call('/meetings/9?series=1',{method:'DELETE',user:3})).status,409); assert.deepEqual(state.meeting,before);
  });
  await test('all schedule PATCH routes validate merged endpoints and permit same-day/valid updates', async () => {
    for (const [path,model] of [['vacations','vacation'],['business-trips','businessTrip'],['shoots','shoot']]) {
      state[model]=[{id:1,staffId:2,createdById:2,startDate:day('2026-10-10'),endDate:day('2026-10-20')}];
      for (const body of [{startDate:'2026-10-21'},{endDate:'2026-10-09'},{startDate:'2026-10-21',endDate:'2026-10-20'}]) {
        const before=structuredClone(state[model]); const r=await call('/'+path+'/1',{method:'PATCH',body,user:2});
        assert.equal(r.status,422,path); assert.equal(r.data.error,'invalid_range'); assert.deepEqual(state[model],before);
      }
      assert.equal((await call('/'+path+'/1',{method:'PATCH',body:{startDate:'2026-10-20'},user:2})).status,200);
      assert.equal((await call('/'+path+'/1',{method:'PATCH',body:{startDate:'2026-10-22',endDate:'2026-10-23'},user:2})).status,200);
      assert.equal((await call('/'+path+'/1',{method:'PATCH',body:{note:'fixture'},user:3})).status,403);
    }
  });
  await test('all schedule POST/PATCH routes reject impossible calendar dates and accept leap day', async () => {
    for (const [path,model,extras] of [['vacations','vacation',{}],['business-trips','businessTrip',{hotel:'Fixture',task:'Fixture'}],['shoots','shoot',{desc:'Fixture'}]]) {
      state[model]=[{id:1,staffId:2,createdById:2,startDate:day('2026-10-10'),endDate:day('2026-10-20')}];
      for(const invalid of ['2026-02-29','2026-04-31','2026-13-01','2026-00-10','not-a-date']) {
        assert.equal((await call('/'+path+'/1',{method:'PATCH',body:{startDate:invalid},user:2})).status,400);
        assert.equal((await call('/'+path,{method:'POST',body:{...extras,startDate:invalid,endDate:'2026-12-31'},user:2})).status,400);
      }
      const r=await call('/'+path,{method:'POST',body:{...extras,startDate:'2028-02-29',endDate:'2028-02-29'},user:2}); assert.equal(r.status,201,JSON.stringify(r));
    }
  });
  await test('simultaneous partial schedule date edits have one winner and cannot combine into a reversed interval', async () => {
    for (const [path,model] of [['vacations','vacation'],['business-trips','businessTrip'],['shoots','shoot']]) {
      for (const changes of [[{startDate:'2026-10-15'},{endDate:'2026-10-12'}],[{endDate:'2026-10-12'},{startDate:'2026-10-15'}]]) {
        reset();state[model]=[{id:1,staffId:2,createdById:2,startDate:day('2026-10-10'),endDate:day('2026-10-20')}];
        let readers=0,release;const bothRead=new Promise(resolve=>{release=resolve;});
        scheduleLookupBarrier={model,wait:async()=>{if(++readers<=2){if(readers===2)release();await bothRead;}}};
        const results=await Promise.all(changes.map(body=>call('/'+path+'/1',{method:'PATCH',body,user:2})));
        assert.deepEqual(results.map(r=>r.status).sort(),[200,409],path);
        assert.equal(results.find(r=>r.status===409).data.error,'schedule_conflict');
        assert(state[model][0].endDate>=state[model][0].startDate,path+' must retain a valid interval');
        assert.equal(writes,2,'both CAS statements execute; only the first matches its original date pair');
      }
    }
  });
  const token='synthetic-activation-token-minimum-32-characters';
  function pending(){Object.assign(state.staff.find(p=>p.id===2),{pendingActivation:true,activationTokenHash:hashToken(token),activationExpires:new Date(Date.now()+60000),sessionVersion:7});}
  await test('concurrent activation has one successful claim/cookie and increments sessionVersion once', async () => {
    pending(); let readers=0, release; const bothRead=new Promise(resolve=>{release=resolve;});
    lookupBarrier=async()=>{if(++readers===2)release();await bothRead;};
    const responses=await Promise.all(['SyntheticAlpha42','SyntheticBravo43'].map(password=>call('/auth/activate',{method:'POST',body:{token,password},user:null})));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,404]);
    const winner=responses.find(r=>r.status===200),loser=responses.find(r=>r.status!==200); assert(winner.cookie); assert.equal(loser.cookie,null);
    assert.equal(state.staff.find(p=>p.id===2).sessionVersion,8); assert.equal(state.staff.find(p=>p.id===2).pendingActivation,false);
    assert.equal(state.staff.find(p=>p.id===2).activationTokenHash,null); lookupBarrier=null;
    assert.equal((await call('/auth/me',{authCookie:winner.cookie,user:2})).status,200);
    assert.equal((await call('/auth/me',{authCookie:cookie(2,7),user:2})).status,401);
    assert.equal((await call('/auth/activate',{method:'POST',body:{token,password:'SyntheticCharlie44'},user:null})).status,404);
  });
  await test('activation CAS rejects expiry, reinvite token replacement and deactivation during hash without a cookie', async () => {
    for (const mutation of [s=>{s.activationExpires=new Date(Date.now()-1000);},s=>{s.activationTokenHash=hashToken('synthetic-replacement');},s=>{s.active=false;}]) {
      reset();pending();hashHook=async password=>{mutation(state.staff.find(p=>p.id===2));return 'synthetic-hash:'+password;};
      const r=await call('/auth/activate',{method:'POST',body:{token,password:'SyntheticAlpha42'},user:null});
      assert.equal(r.status,404);assert.equal(r.cookie,null);assert.equal(state.staff.find(p=>p.id===2).pendingActivation,true);assert.equal(state.staff.find(p=>p.id===2).sessionVersion,7);
    }
  });
  await test('reinvite cannot overwrite the password after activation wins during placeholder hashing', async () => {
    pending();hashHook=async()=>{const s=state.staff.find(p=>p.id===2);Object.assign(s,{pendingActivation:false,password:'synthetic-activation-winner-hash',activationTokenHash:null,activationExpires:null,sessionVersion:8});return 'synthetic-reinvite-placeholder';};
    const r=await call('/staff/2/reinvite',{method:'POST',body:{}});assert.equal(r.status,409);assert.equal(r.data.error,'invitation_changed');
    assert.equal(state.staff.find(p=>p.id===2).password,'synthetic-activation-winner-hash');assert.equal(state.notification.length,0);
  });
  function reminder(){
    const future=new Date(Date.now()+10*60000),taipei=new Date(+future+8*3600000);
    return {id:50,title:'Synthetic reminder',date:day(taipei.toISOString().slice(0,10)),startTime:taipei.toISOString().slice(11,16),remindMinutes:30,remindedAt:null,status:'scheduled',hostId:2,attendees:[{staffId:2},{staffId:3}],caseId:null,location:'Fixture'};
  }
  await test('reminder recipient insertion failure rolls back entire batch and retry delivers once per recipient', async () => {
    state.meeting=[reminder()];failNotificationAt=2;
    await checkMeetingReminders();assert.equal(state.meeting[0].remindedAt,null);assert.equal(state.notification.length,0);
    failNotificationAt=null;await checkMeetingReminders();assert(state.meeting[0].remindedAt);assert.deepEqual(state.notification.map(n=>n.recipientId).sort(),[2,3]);
    const before=state.notification.length;await checkMeetingReminders();assert.equal(state.notification.length,before);
  });
  await test('reminder marker failure rolls back durable notifications and leaves the retry eligible', async () => {
    state.meeting=[reminder()];failMarker=true;await checkMeetingReminders();assert.equal(state.notification.length,0);assert.equal(state.meeting[0].remindedAt,null);
    failMarker=false;await checkMeetingReminders();assert.equal(state.notification.length,2);assert(state.meeting[0].remindedAt);
  });
  await test('independent reminder workers survive a Serializable commit conflict with one durable batch', async () => {
    const workerA=(await import(root+'/src/services/meetingReminders.js?fixture-worker=A')).checkMeetingReminders;
    const workerB=(await import(root+'/src/services/meetingReminders.js?fixture-worker=B')).checkMeetingReminders;
    state.meeting=[reminder()];commitFailures=1;
    await workerA();assert.equal(state.notification.length,0);assert.equal(state.meeting[0].remindedAt,null);
    await workerB();assert.equal(state.notification.length,2);assert(state.meeting[0].remindedAt);
    reset();state.meeting=[reminder()];commitFailures=1;
    await Promise.all([workerA(),workerB()]);assert.equal(state.notification.length,2);assert(state.meeting[0].remindedAt);
    assert.equal(notificationAttempts,4,'the aborted batch was discarded before the competing worker committed');
    assert(transactionOptions.every(o=>o.isolationLevel==='Serializable'));
  });
  await test('overlapping reminder checks share one batch and expired windows never falsely mark sent', async () => {
    state.meeting=[reminder()];await Promise.all([checkMeetingReminders(),checkMeetingReminders()]);assert.equal(state.notification.length,2);
    reset();const past=reminder();past.date=day('2020-01-01');state.meeting=[past];await checkMeetingReminders();assert.equal(state.notification.length,0);assert.equal(past.remindedAt,null);
  });
  await test('a meeting with no recipients never receives a sent marker without a durable notification', async () => {
    state.meeting=[{...reminder(),hostId:null,attendees:[]}];await checkMeetingReminders();assert.equal(state.notification.length,0);assert.equal(state.meeting[0].remindedAt,null);
  });
  console.log(JSON.stringify({passed,scope:'synthetic route/service safety; no live DB or SMTP'}));
} finally { server.close(); await prisma.$disconnect(); }
