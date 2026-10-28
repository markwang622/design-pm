// REPORTS-P1-B: the actual public/case-deliveries.js plugin in an inert minimal DOM.
// The DOM scaffold is copied from tests/analyticsUiSafety.mjs (models bubbling, disabled clicks,
// selects). escapeHtml / normalizeCase / v10SyncUpdatedAt / v20TaiwanToday are extracted from the
// real index.html. No network, database, browser automation, mail or production data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
process.env.TZ = 'Asia/Taipei';
const root = process.env.DESIGN_PM_ROOT || new URL('../', import.meta.url).pathname;
const source = fs.readFileSync(root + '/public/index.html', 'utf8');
const plugin = fs.readFileSync(root + '/public/case-deliveries.js', 'utf8');
const css = fs.readFileSync(root + '/public/case-deliveries.css', 'utf8');
function section(start, end, text = source) { const a = text.indexOf(start), b = text.indexOf(end, a + start.length); assert(a >= 0 && b > a, 'source section exists: ' + start); return text.slice(a, b); }
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const plain = v => JSON.parse(JSON.stringify(v));
const decode=s=>String(s).replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&#x27;':"'"}[x]));
function dom(){
  const all=[];
  function element(tag='div',id=''){
    const n={tagName:tag.toUpperCase(),id,style:{},dataset:{},attributes:{},children:[],parentNode:null,_value:undefined,disabled:false,checked:false,_text:'',_html:'',events:{}};
    Object.defineProperty(n,'value',{get(){
      if(n.tagName==='SELECT'){
        const options=n.querySelectorAll('option');
        if(n._value!==undefined)return options.find(x=>x.value===n._value)?.value??'';
        return (options.find(x=>x.getAttribute('selected')!==null)||options[0])?.value??'';
      }
      return n._value??(n.tagName==='TEXTAREA'?n.textContent:n.tagName==='OPTION'?n.textContent:'');
    },set:v=>{n._value=String(v??'');}});
    let classes=new Set();
    Object.defineProperty(n,'className',{get:()=>[...classes].join(' '),set:v=>classes=new Set(String(v).split(/\s+/).filter(Boolean))});
    n.classList={add(...xs){xs.forEach(x=>classes.add(x));},remove(...xs){xs.forEach(x=>classes.delete(x));},contains:x=>classes.has(x),toggle(x,v){v??=!classes.has(x);v?classes.add(x):classes.delete(x);}};
    n.setAttribute=(key,value)=>{value=String(value);n.attributes[key]=value;if(key==='id')n.id=value;else if(key==='class')n.className=value;else if(key==='value')n.value=value;else if(key==='disabled')n.disabled=true;else if(key.startsWith('data-'))n.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;};
    n.getAttribute=key=>key==='id'?n.id:key==='class'?n.className:n.attributes[key]??(key.startsWith('data-')?n.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]??null:null);
    n.removeAttribute=key=>{delete n.attributes[key];if(key==='disabled')n.disabled=false;};
    n.appendChild=child=>{child.remove();child.parentNode=n;n.children.push(child);return child;};
    n.insertBefore=(child,before)=>{child.remove();child.parentNode=n;const i=n.children.indexOf(before);if(i<0)n.children.push(child);else n.children.splice(i,0,child);return child;};
    n.remove=()=>{if(n.parentNode){const p=n.parentNode;p.children=p.children.filter(x=>x!==n);n.parentNode=null;}};
    n.replaceChildren=(...children)=>{n.children.forEach(x=>x.parentNode=null);n.children=[];n._text='';children.forEach(c=>n.appendChild(c));};
    Object.defineProperty(n,'isConnected',{get(){let p=n;while(p){if(p===document.body||p===document.head)return true;p=p.parentNode;}return false;}});
    Object.defineProperty(n,'firstChild',{get:()=>n.children[0]||null});
    Object.defineProperty(n,'firstElementChild',{get:()=>n.children[0]||null});
    Object.defineProperty(n,'textContent',{get:()=>n._text+n.children.map(x=>x.textContent).join(''),set:v=>{n.replaceChildren();n._text=String(v??'');n._html='';}});
    Object.defineProperty(n,'innerHTML',{get:()=>n._html,set:value=>{
      n.replaceChildren();n._html=String(value);const stack=[n];let last=0;
      let parsedTags=0;
      for(const m of n._html.matchAll(/<(\/?)([a-z][\w:-]*)([^>]*)>/gi)){
        if(++parsedTags>12000)break;
        stack.at(-1)._text+=decode(n._html.slice(last,m.index));last=m.index+m[0].length;
        if(m[1]){if(stack.length>1)stack.pop();continue;}
        const child=element(m[2]);
        for(const a of m[3].matchAll(/([^\s=/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))child.setAttribute(a[1],decode(a[2]??a[3]??a[4]??''));
        stack.at(-1).appendChild(child);
        if(!['input','img','br','hr','meta','link'].includes(m[2].toLowerCase())&&!m[3].endsWith('/'))stack.push(child);
      }
      stack.at(-1)._text+=decode(n._html.slice(last));
    }});
    const descendants=()=>n.children.flatMap(x=>[x,...x.querySelectorAll('*')]);
    n.querySelectorAll=selector=>{
      const selectors=selector.split(',').map(s=>s.trim());
      return descendants().filter(x=>selectors.some(s=>{
        const tokens=s.split(/\s+/);let current=x;
        if(!matches(current,tokens.pop()))return false;
        while(tokens.length){const wanted=tokens.pop();current=current.parentNode;while(current&&current!==n&&!matches(current,wanted))current=current.parentNode;if(!current||current===n&&!matches(current,wanted))return false;}
        return true;
      }));
    };
    n.querySelector=selector=>n.querySelectorAll(selector)[0]||null;
    n.closest=selector=>{let current=n;while(current){if(matches(current,selector))return current;current=current.parentNode;}return null;};
    n.addEventListener=(type,fn)=>{(n.events[type]||=[]).push(fn);};
    n.click=()=>{if(n.disabled)return;let stopped=false;const event={type:'click',target:n,preventDefault(){},stopPropagation(){stopped=true;}};const returned=n.onclick?.(event);for(const fn of n.events.click||[])fn(event);let parent=n.parentNode;while(parent&&!stopped){parent.onclick?.(event);for(const fn of parent.events.click||[])fn(event);parent=parent.parentNode;}if(!stopped)document.dispatchEvent(event);return returned;};
    n.prepend=child=>n.insertBefore(child,n.firstChild);n.focus=()=>{};n.select=()=>{};n.scrollIntoView=()=>{};n.insertAdjacentElement=(_pos,child)=>n.parentNode?.appendChild(child);
    n.contains=child=>{let p=child;while(p){if(p===n)return true;p=p.parentNode;}return false;};
    n.dispatchEvent=(event)=>{event={bubbles:true,...event};event.target??=n;let stopped=false;event.preventDefault??=()=>{event.defaultPrevented=true;};event.stopPropagation??=()=>{stopped=true;};let returned;let current=n;while(current){event.currentTarget=current;const result=current['on'+event.type]?.(event);if(current===n)returned=result;for(const fn of current.events[event.type]||[])fn(event);if(stopped||event.bubbles===false)break;current=current.parentNode;}if(!stopped&&event.bubbles!==false)document.dispatchEvent(event);return returned;};
    n.click=()=>{if(n.disabled)return;return n.dispatchEvent({type:'click'});};
    n.focus=()=>{document.activeElement=n;};
    Object.defineProperty(n,'type',{get:()=>n.getAttribute('type')||''});
    all.push(n);return n;
  }
  function matches(n,s){
    if(s==='*')return true;
    for(const m of s.matchAll(/:not\(([^)]+)\)/g))if(matches(n,m[1]))return false;
    s=s.replace(/:not\([^)]+\)/g,'');
    const tag=s.match(/^[a-z][\w-]*/i);if(tag&&n.tagName!==tag[0].toUpperCase())return false;
    const id=s.match(/#([\w-]+)/);if(id&&n.id!==id[1])return false;
    for(const m of s.matchAll(/\.([\w-]+)/g))if(!n.classList.contains(m[1]))return false;
    for(const m of s.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)){const v=n.getAttribute(m[1]);if(v===null)return false;const want=m[2]??m[3]??m[4];if(want!==undefined&&v!==want)return false;}
    if(s.includes(':checked')&&!n.checked)return false;
    return true;
  }
  const document={createElement:tag=>element(tag),getElementById:id=>all.find(n=>n.id===id&&n.isConnected)||null,execCommand(){throw Error('No real clipboard fallback permitted');}};
  document.events={};document.addEventListener=(type,fn)=>{(document.events[type]||=[]).push(fn);};document.dispatchEvent=event=>{for(const fn of document.events[event.type]||[])fn(event);};
  document.body=element('body');document.head=element('head');
  document.querySelectorAll=s=>[...document.body.querySelectorAll(s),...document.head.querySelectorAll(s)];document.querySelector=s=>document.querySelectorAll(s)[0]||null;
  const seed=(id,tag='div',parent=document.body)=>parent.appendChild(element(tag,id));
  return{document,element,seed,get:id=>document.getElementById(id)};
}

const helpers = section('function escapeHtml(s)', 'async function v33SaveEdit') + section('function v20TaiwanToday()', '\n}\n') + '\n}\n'
  + section('function normalizeCase(b)', 'function findStaffId') + section('function v10SyncUpdatedAt(c, raw)', '// 409 = 他人已更新');
function makeStorage() {
  const map = new Map(); let broken = false;
  return { map, break(v = true) { broken = v; },
    getItem: k => { if (broken) throw Error('storage blocked'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (broken) throw Error('storage blocked'); map.set(k, String(v)); },
    removeItem: k => { if (broken) throw Error('storage blocked'); map.delete(k); } };
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const record = (extra = {}) => ({ id: 'dlv-existing-1', caseId: 'A-1', itemKey: null, itemName: '主視覺 KV', kind: 'main', quantity: 1, unit: '件', deliveredOn: '2026-10-21', note: null,
  recordedById: 2, recordedByName: 'Owner', createdAt: '2026-10-21T01:00:00.000Z', voided: false, voidedAt: null, voidedById: null, voidedByName: null, voidReason: null, ...extra });
const listing = (records = [], extra = {}) => ({ caseId: 'A-1', updatedAt: '2026-10-22T01:00:00.000Z', contentVersion: 5, records,
  summary: summarize(records), legacy: { requestCount: null, outputCount: null, requestCountStatus: 'unknown', outputCountStatus: 'unknown' }, ...extra });
function summarize(records) {
  const act = records.filter(r => !r.voided), groups = [];
  for (const kind of ['main', 'extension', 'support']) { const rows = act.filter(r => r.kind === kind); if (rows.length) groups.push({ kind, unit: '件', quantity: rows.reduce((s, r) => s + r.quantity, 0), records: rows.length }); }
  return { status: act.length ? 'recorded' : 'unknown', groups, activeRecords: act.length, voidedRecords: records.length - act.length, zeroSupportRecords: act.filter(r => r.kind === 'support' && r.quantity === 0).length };
}
const caseRow = (id = 'A-1', extra = {}) => ({ id, name: '品牌年度主視覺', status: 'doing', archived: false, _designerId: 2, _collaboratorIds: [4], designer: 'Owner', collaborators: ['Collab'],
  items: [{ key: 'item-key-main-0001', n: '主視覺 KV' }, { n: '無 key 舊項目' }], _updatedAt: '2026-10-22T01:00:00.000Z', _contentVersion: 5, ...extra });

function env({ me = { id: 2, name: 'Owner', role: 'member' }, role = 'designer', storage = makeStorage(), responder } = {}) {
  const d = dom(), calls = [], toasts = [];
  const drawer = d.seed('drawer'); const body = d.element('div'); body.className = 'drawer-body'; drawer.appendChild(body);
  const archive = d.element('div', 'd-archive'); body.appendChild(archive); const status = d.element('div'); status.className = 'status-change'; body.appendChild(status);
  const c = vm.createContext({ console, Date, Intl, Set, Map, Promise, JSON, Math, Number, String, Object, Array, Error, URLSearchParams, crypto: webcrypto,
    setTimeout, clearTimeout, document: d.document, sessionStorage: storage, ME: me, currentRole: role, STAFF: [], CASES: [], currentCase: null, TODAY: new Date(today + 'T00:00:00+08:00'),
    showToast: (m, t) => toasts.push({ m, t }) });
  c.window = c;
  vm.runInContext(helpers + '\nconst IS_OBSERVER = () => currentRole === "observer";', c);
  c.v95DrawerSeq = (() => { let n = 0; return { bump: () => ++n, now: () => n }; })();
  c.fetchJson = async (method, url, payload) => { const call = { method, url, body: payload === undefined ? undefined : plain(payload) }; calls.push(call); return responder(call); };
  // Base drawer chain stand-in: sets currentCase, bumps the generation and sweeps every control (like v36/v37).
  c.openDrawer = async row => { c.currentCase = row; c.v95DrawerSeq.bump(); await Promise.resolve(); d.get('drawer').querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; el.classList.add('v37-historical-readonly'); }); };
  vm.runInContext(plugin, c);
  const rootEl = () => d.get('d-deliveries');
  const text = () => rootEl()?.textContent || '';
  const btn = label => rootEl().querySelectorAll('button').find(b => b.textContent.trim() === label);
  const field = name => rootEl().querySelector(`[data-f="${name}"]`);
  const type = (name, value) => { const el = field(name); el.value = value; el.dispatchEvent({ type: el.tagName === 'SELECT' ? 'change' : 'input' }); };
  const open = async row => { c.CASES = [row]; c.openDrawer(row); await flush(); return row; };
  return { c, d, calls, toasts, storage, rootEl, text, btn, field, type, open, posts: () => calls.filter(x => x.method === 'POST') };
}
const okList = (records = []) => call => { if (call.method === 'GET') return listing(records); throw Error('unexpected ' + call.method); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } }

await test('mounts after the drawer sweep, below the archive field, with heading, help and unknown (not zero) summary', async () => {
  const t = env({ responder: okList() }); await t.open(caseRow());
  const root = t.rootEl(); assert(root, 'section mounted'); assert.equal(root.parentNode.children.indexOf(root), root.parentNode.children.indexOf(t.d.get('d-archive')) + 1);
  assert.match(t.text(), /交付成果/); assert.match(t.text(), /交付一次登錄一次，主設計與延伸分開統計。/);
  assert.match(t.text(), /尚未登錄交付明細（未知，不代表 0 件）/); assert(!/合計|總計/.test(t.text()), 'no grand KPI total');
  const add = t.btn('新增交付'); assert(add); assert.equal(add.disabled, false, 'own controls are rendered after the sweep and stay enabled');
  assert.equal(t.calls[0].url, '/api/cases/A-1/deliveries');
});
await test('feature_disabled hides the section quietly and later drawers do not refetch', async () => {
  const t = env({ responder: () => { throw Object.assign(Error('x'), { status: 404, data: { error: 'feature_disabled' } }); } });
  await t.open(caseRow()); assert.equal(t.rootEl(), null); await t.open(caseRow('B-2')); assert.equal(t.calls.length, 1);
});
await test('grouped summary, legacy totals, explicit support zero and voided evidence render without a combined total', async () => {
  const records = [record(), record({ id: 'r2', kind: 'extension', quantity: 3, itemName: '延伸 3 尺寸' }), record({ id: 'r3', kind: 'support', quantity: 0, itemName: '版面諮詢', note: '提供版面諮詢，未新增設計檔案' }),
    record({ id: 'r4', quantity: 9, voided: true, voidReason: '數量登錄錯誤', voidedByName: 'Owner' })];
  const t = env({ responder: () => listing(records, { legacy: { requestCount: 2, outputCount: 7, requestCountStatus: 'legacy_total', outputCountStatus: 'legacy_total' } }) });
  await t.open(caseRow());
  // The scaffold's textContent concatenates a parent's own text before its children, so assert on markup.
  const html = t.rootEl().innerHTML; assert.equal(t.rootEl().querySelectorAll('.cd-chip').length, 3);
  for (const chip of ['主設計 <b>1</b> 件', '延伸 <b>3</b> 件', '支援 <b>0</b> 件']) assert(html.includes(chip), chip);
  assert(html.includes('舊版總量，尚無交付日期明細：設計產出 <b>7</b>、需求 <b>2</b>')); assert.match(t.text(), /0 件，已附說明/);
  const voidRow = t.rootEl().querySelector('[data-record="r4"]'); assert(voidRow.classList.contains('is-void')); assert.match(voidRow.textContent, /已作廢/); assert.match(voidRow.textContent, /數量登錄錯誤/);
  assert.equal(voidRow.querySelectorAll('button').length, 0, 'voided evidence has no actions'); assert(!/合計|總計|10 件/.test(t.text()));
});
for (const [label, opts, row, expect] of [
  ['observer', { me: { id: 2, name: 'Owner', role: 'observer' } }, caseRow(), /觀察者為唯讀/],
  ['observer preview mode', { role: 'observer' }, caseRow(), /觀察者為唯讀/],
  ['unassigned member', { me: { id: 3, name: 'Owner', role: 'member' } }, caseRow(), /不是此案件的主責或協作者/],
  ['same name, different id', { me: { id: 9, name: 'Owner', role: 'member' } }, caseRow(), /不是此案件的主責或協作者/],
  ...['review_done', 'done', 'closed', 'cancelled'].map(s => [s, {}, caseRow('A-1', { status: s }), /僅供檢視/]),
  ['archived', {}, caseRow('A-1', { archived: true }), /僅供檢視/],
]) await test('read-only evidence for ' + label, async () => {
  const t = env({ ...opts, responder: okList([record()]) }); await t.open(row);
  assert.match(t.text(), expect); assert.equal(t.rootEl().querySelectorAll('button').filter(b => /新增交付|更正|作廢/.test(b.textContent)).length, 0);
  assert.match(t.text(), /主視覺 KV/, 'evidence remains visible');
});
for (const [label, me] of [['primary', { id: 2, role: 'member' }], ['collaborator by id', { id: '4', role: 'member' }], ['admin', { id: 1, role: 'admin' }]]) await test('mutating controls for ' + label, async () => {
  const t = env({ me: { name: 'X', ...me }, responder: okList([record()]) }); await t.open(caseRow());
  for (const label2 of ['新增交付', '更正', '作廢']) { const b = t.btn(label2); assert(b, label2); assert.equal(b.disabled, false); }
});
await test('new form prefills once, switches support default to 0, requires a meaningful note and posts the exact contract', async () => {
  const t = env({ responder: call => (call.method === 'GET' ? listing([]) : { record: record({ id: call.body.id }), case: { id: 'A-1', updatedAt: '2026-10-22T02:00:00.000Z', contentVersion: 6 }, replayed: false }) });
  const row = await t.open(caseRow()); t.btn('新增交付').click();
  assert.equal(t.field('itemName').value, '品牌年度主視覺'); assert.equal(t.field('kind').value, 'main'); assert.equal(t.field('quantity').value, '1'); assert.equal(t.field('deliveredOn').value, today);
  assert.equal(t.field('deliveredOn').getAttribute('max'), today);
  const options = t.field('itemKey').querySelectorAll('option').map(o => o.value); assert.deepEqual(options, ['', 'item-key-main-0001'], 'only keyed sub-items are offered');
  t.type('itemKey', 'item-key-main-0001'); assert.equal(t.field('itemName').value, '主視覺 KV', 'name follows the chosen sub-item');
  t.type('kind', 'support'); assert.equal(t.field('quantity').value, '0');
  t.btn('儲存交付').click(); await flush();
  assert.equal(t.posts().length, 0); assert.equal(t.field('note').getAttribute('aria-invalid'), 'true'); assert.match(t.text(), /請具體說明/);
  t.type('note', '無'); t.btn('儲存交付').click(); await flush(); assert.equal(t.posts().length, 0);
  t.type('note', '提供版面諮詢，未新增設計檔案'); t.btn('儲存交付').click(); await flush();
  const post = t.posts()[0]; assert.equal(post.url, '/api/cases/A-1/deliveries');
  assert.deepEqual(Object.keys(post.body).sort(), ['deliveredOn', 'expectedContentVersion', 'expectedUpdatedAt', 'id', 'itemKey', 'itemName', 'kind', 'note', 'quantity', 'unit']);
  assert.equal(post.body.quantity, 0); assert.equal(post.body.unit, '件'); assert.equal(post.body.kind, 'support'); assert.equal(post.body.itemKey, 'item-key-main-0001');
  assert.equal(post.body.expectedContentVersion, 5); assert.match(post.body.id, /^[A-Za-z0-9_-]{8,100}$/);
  assert.match(t.text(), /交付已儲存/); assert.equal(row._contentVersion, 6, 'authoritative version merged via v10SyncUpdatedAt'); assert.equal(row._updatedAt, '2026-10-22T02:00:00.000Z');
  assert.equal(t.calls.filter(x => x.method === 'GET').length, 2, 'evidence reloaded'); assert.equal(t.c.caseDeliveriesUi.readDraft(2, 'A-1', 'new'), null, 'draft cleared after success');
});
await test('invalid quantities and dates are refused locally without a request', async () => {
  const t = env({ responder: okList() }); await t.open(caseRow()); t.btn('新增交付').click();
  for (const [f, v] of [['quantity', '1.5'], ['quantity', '-1'], ['quantity', '1x'], ['quantity', '1000001'], ['quantity', '0'], ['deliveredOn', '2099-01-01'], ['deliveredOn', '2026-02-30'], ['itemName', '  ']]) {
    const u = env({ responder: okList() }); await u.open(caseRow()); u.btn('新增交付').click();
    u.type(f, v); u.btn('儲存交付').click(); await flush();
    assert.equal(u.posts().length, 0, f + '=' + v); assert(u.rootEl().querySelector('[aria-invalid="true"]'), f + '=' + v);
  }
  assert.equal(t.posts().length, 0);
});
await test('drafts survive cancel, close/reopen and case switching; are per user and per operation; storage failure falls back to memory', async () => {
  const storage = makeStorage(); const t = env({ storage, responder: okList([record()]) });
  await t.open(caseRow()); t.btn('新增交付').click(); t.type('itemName', '草稿中的品名'); t.btn('取消').click();
  assert.equal(t.field('itemName'), null, 'cancel closes the form'); assert(t.btn('新增交付（有草稿）'));
  await t.open(caseRow('B-2')); assert(t.btn('新增交付'), 'case B has no draft'); assert(!t.btn('新增交付（有草稿）'));
  await t.open(caseRow()); t.btn('新增交付（有草稿）').click(); assert.equal(t.field('itemName').value, '草稿中的品名');
  t.btn('更正').click(); t.type('reason', '更正草稿原因'); t.btn('取消').click();
  t.btn('更正').click(); assert.equal(t.field('reason').value, '更正草稿原因', 'correction draft keyed by target');
  t.c.ME = { id: 4, name: 'Collab', role: 'member' }; await t.open(caseRow()); t.btn('新增交付').click();
  assert.equal(t.field('itemName').value, '品牌年度主視覺', 'another signed-in user never sees the draft');
  assert(![...storage.map.keys()].some(k => !/^dpm\.delivery\.v1/.test(k)));
  storage.break(); t.type('itemName', '儲存空間失效仍可輸入'); t.btn('取消').click(); t.btn('新增交付（有草稿）').click();
  assert.equal(t.field('itemName').value, '儲存空間失效仍可輸入', 'memory fallback keeps the draft without crashing');
  t.btn('捨棄草稿').click(); assert.match(t.text(), /已捨棄草稿/); assert(t.btn('新增交付'));
});
await test('ambiguous network failure keeps the exact request, locks content and retries the same id before anything else', async () => {
  let mode = 'fail';
  const t = env({ responder: call => {
    if (call.method === 'GET') return listing([]);
    if (mode === 'fail') throw Object.assign(Error('net'), { status: 0, data: { error: 'network' } });
    return { record: record({ id: call.body.id }), case: { id: 'A-1', updatedAt: '2026-10-22T03:00:00.000Z', contentVersion: 6 }, replayed: true };
  } });
  await t.open(caseRow()); t.btn('新增交付').click(); t.type('itemName', '第一份'); t.btn('儲存交付').click(); await flush();
  assert.match(t.text(), /無法確認是否已儲存/); assert(t.rootEl().querySelector('fieldset').getAttribute('disabled') !== null, 'content locked');
  assert.equal(t.btn('捨棄草稿').disabled, true); const first = t.posts()[0].body;
  t.type('itemName', '偷改內容'); assert.equal(t.c.caseDeliveriesUi.readDraft(2, 'A-1', 'new').values.itemName, '第一份', 'changes ignored while pending');
  await t.open(caseRow('B-2')); await t.open(caseRow()); assert(t.btn('重新確認送出'), 'reopening forces reconciliation first');
  mode = 'ok'; t.btn('重新確認送出').click(); await flush();
  assert.equal(t.posts().length, 2); assert.deepEqual(t.posts()[1].body, first, 'identical request identity and content');
  assert.match(t.text(), /交付已儲存/);
});
await test('definite rejections keep the content, clear the pending identity and explain the next action', async () => {
  for (const [error, expect] of [
    [{ status: 409, data: { error: 'edit_conflict' } }, '資料已更新，你的內容已保留。請重新整理明細後再儲存。'],
    [{ status: 409, data: { error: 'case_locked' } }, '案件已送核可、結案、取消或封存'], [{ status: 403, data: { error: 'forbidden' } }, '沒有此案件的交付登錄權限'],
    [{ status: 422, data: { error: 'delivered_on_future', message: '交付日期不可晚於今天（台北時間）' } }, '交付日期不可晚於今天（台北時間），內容已保留。'],
    [{ status: 400, data: { error: 'invalid_body', issues: [{ path: ['quantity'] }] } }, '欄位格式不正確：數量'],
  ]) {
    const t = env({ responder: call => { if (call.method === 'GET') return listing([]); throw Object.assign(Error('stack: internal at db.js'), error); } });
    await t.open(caseRow()); t.btn('新增交付').click(); t.type('itemName', '保留這段'); t.btn('儲存交付').click(); await flush();
    assert(t.text().includes(expect), expect); assert(!/stack|db\.js|HTTP|Prisma/.test(t.text()), 'no internals'); assert.equal(t.field('itemName').value, '保留這段');
    assert.equal(t.c.caseDeliveriesUi.readDraft(2, 'A-1', 'new').pending, null);
    t.btn('儲存交付').click(); await flush(); assert.notEqual(t.posts()[1].body.id, t.posts()[0].body.id, 'a rejected request id is not reused');
  }
});
await test('pending save disables only its form, ignores double clicks and keeps navigation usable', async () => {
  const gate = deferred(); const t = env({ responder: call => (call.method === 'GET' ? listing([]) : gate.promise) });
  await t.open(caseRow()); t.btn('新增交付').click(); t.btn('儲存交付').click(); await flush();
  assert.equal(t.btn('儲存交付').disabled, true); t.btn('儲存交付').click(); await flush(); assert.equal(t.posts().length, 1);
  assert.equal(t.btn('重新整理明細').disabled, false); assert.equal(t.btn('取消').disabled, false);
  gate.resolve({ record: record(), case: { id: 'A-1', updatedAt: '2026-10-22T04:00:00.000Z', contentVersion: 6 } }); await flush(); assert.match(t.text(), /交付已儲存/);
});
await test('a late success for case A never paints into case B, but still records A’s version and clears A’s draft', async () => {
  const gate = deferred(); const t = env({ responder: call => (call.method === 'GET' ? listing(call.url.includes('B-2') ? [record({ id: 'rb', itemName: 'B 案交付' })] : []) : gate.promise) });
  const a = await t.open(caseRow()); t.btn('新增交付').click(); t.type('itemName', 'A 案草稿'); t.btn('儲存交付').click(); await flush();
  await t.open(caseRow('B-2')); assert.match(t.text(), /B 案交付/);
  gate.resolve({ record: record(), case: { id: 'A-1', updatedAt: '2026-10-22T05:00:00.000Z', contentVersion: 7 } }); await flush();
  assert(!/交付已儲存|A 案草稿/.test(t.text()), 'B shows only B'); assert.equal(a._contentVersion, 7); assert.equal(t.c.caseDeliveriesUi.readDraft(2, 'A-1', 'new'), null);
});
await test('a late GET for case A cannot replace case B’s evidence; switching clears A’s section synchronously', async () => {
  const gate = deferred(); const t = env({ responder: call => (call.url.includes('A-1') ? gate.promise : listing([record({ id: 'rb', itemName: 'B 案交付' })])) });
  t.c.openDrawer(caseRow()); await flush(); t.c.openDrawer(caseRow('B-2'));
  assert.equal(t.rootEl().hidden, true, 'hidden synchronously while the next drawer opens'); await flush();
  gate.resolve(listing([record({ itemName: 'A 案交付' })])); await flush(); assert.match(t.text(), /B 案交付/); assert(!/A 案交付/.test(t.text()));
});
await test('correction uses the atomic replace endpoint with a required reason and reports that the original is kept', async () => {
  const t = env({ responder: call => (call.method === 'GET' ? listing([record()]) : { original: record({ voided: true }), replacement: record({ id: call.body.id, quantity: 2 }), case: { id: 'A-1', updatedAt: '2026-10-22T06:00:00.000Z', contentVersion: 6 } }) });
  await t.open(caseRow()); t.btn('更正').click();
  assert.equal(t.field('itemName').value, '主視覺 KV'); assert.equal(t.field('quantity').value, '1'); assert.equal(t.field('deliveredOn').value, '2026-10-21');
  t.type('quantity', '2'); t.btn('儲存更正').click(); await flush(); assert.equal(t.posts().length, 0); assert.match(t.text(), /請填寫更正原因/);
  t.type('reason', '數量登錄錯誤'); t.btn('儲存更正').click(); await flush();
  const p = t.posts()[0]; assert.equal(p.url, '/api/cases/A-1/deliveries/dlv-existing-1/replace'); assert.equal(p.body.reason, '數量登錄錯誤'); assert.equal(p.body.quantity, 2);
  assert.match(t.text(), /更正已儲存，原紀錄已保留/);
});
await test('void explains the consequence, requires a reason and posts a stable request id', async () => {
  const t = env({ responder: call => (call.method === 'GET' ? listing([record()]) : { record: record({ voided: true }), case: { id: 'A-1', updatedAt: '2026-10-22T07:00:00.000Z', contentVersion: 6 } }) });
  await t.open(caseRow()); t.btn('作廢').click();
  assert.match(t.text(), /作廢後原紀錄會保留並標示「已作廢」，不再計入交付摘要/);
  t.btn('作廢這筆交付').click(); await flush(); assert.equal(t.posts().length, 0);
  t.type('reason', '重複登錄'); t.btn('作廢這筆交付').click(); await flush();
  const p = t.posts()[0]; assert.equal(p.url, '/api/cases/A-1/deliveries/dlv-existing-1/void'); assert.equal(p.body.reason, '重複登錄'); assert.match(p.body.requestId, /^[A-Za-z0-9_-]{8,100}$/);
  assert.match(t.text(), /已作廢，原紀錄已保留/);
});
await test('long and hostile text is escaped and cannot create elements', async () => {
  const hostile = '<img src=x onerror=alert(1)>' + '很長的交付品名'.repeat(25);
  const t = env({ responder: okList([record({ itemName: hostile, note: '<script>bad()</script>' + '說明'.repeat(400) })]) }); await t.open(caseRow());
  assert.equal(t.rootEl().querySelectorAll('img').length, 0); assert.equal(t.rootEl().querySelectorAll('script').length, 0); assert(t.text().includes('<img src=x'));
});
await test('keyboard: opening focuses the first field, Enter saves from a field (not the note), cancel returns focus', async () => {
  const t = env({ responder: call => (call.method === 'GET' ? listing([]) : { record: record(), case: { id: 'A-1', updatedAt: '2026-10-22T08:00:00.000Z', contentVersion: 6 } }) });
  await t.open(caseRow()); t.btn('新增交付').click();
  assert.equal(t.d.document.activeElement?.dataset?.f, 'itemKey', 'first form control receives focus');
  t.field('note').dispatchEvent({ type: 'keydown', key: 'Enter' }); await flush(); assert.equal(t.posts().length, 0, 'Enter inside the note adds a line, never submits');
  t.btn('取消').click(); assert.equal(t.d.document.activeElement?.dataset?.act, 'new', 'focus returns to the trigger');
  t.btn('新增交付（有草稿）').click(); t.field('itemName').dispatchEvent({ type: 'keydown', key: 'Enter' }); await flush();
  assert.equal(t.posts().length, 1); assert.match(t.text(), /交付已儲存/);
  for (const b of t.rootEl().querySelectorAll('button')) assert(b.textContent.trim().length > 0 && !/^(確認|送出|提交|OK)$/.test(b.textContent.trim()), 'explicit labels only');
});
await test('stylesheet: nowrap buttons, wrapping rows and token pairs meet contrast in light and dark themes', async () => {
  assert.match(css, /\.cd-btn\{[^}]*white-space:nowrap/); assert.match(css, /\.cd-btn\{[^}]*word-break:keep-all/); assert.match(css, /\.cd-actions\{[^}]*flex-wrap:wrap/);
  assert.match(css, /overflow-wrap:anywhere/); assert(!/!important/.test(css), 'no !important overrides');
  // 390px acceptance: touch targets are at least 44px on narrow screens, desktop keeps its 32/34px density.
  const narrow = [...css.matchAll(/@media\(max-width:620px\)\{([\s\S]*?)\}\s*(?=\/\*|@media|$)/g)].map(m => m[1]).join('\n');
  assert.match(narrow, /\.cd-root \.cd-btn\{[^}]*min-height:44px/); assert.match(narrow, /\.cd-root \.cd-field input,\.cd-root \.cd-field select\{min-height:44px\}/);
  assert.match(css, /^\.cd-btn\{[^}]*min-height:32px/m, 'desktop button density unchanged');
  const hex = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const lum = rgb => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const [r, g, b] = rgb.map(f); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (rgba, base) => rgba.slice(0, 3).map((v, i) => v * rgba[3] + base[i] * (1 - rgba[3]));
  const tok = (block, name) => { const m = block.match(new RegExp(name.replace(/[-]/g, '\\-') + ':\\s*([^;]+);')); assert(m, name); return m[1].trim(); };
  const light = source.slice(source.indexOf(':root {\n  --hf-bg:')); const dark = source.slice(source.indexOf('[data-theme="dark"] {\n  --hf-bg:'));
  const darkDk = source.slice(source.indexOf('[data-theme="dark"] {\n  --dk-muted:'));
  const T = { light: { ink: tok(light, '--hf-ink'), muted: tok(light, '--hf-muted'), paper: tok(light, '--hf-paper'), soft: tok(light, '--hf-soft'), bg: tok(light, '--hf-bg'), red: '#9A2E2E', green: '#1F6B3A', surface: [255, 255, 255, 0.72] },
    dark: { ink: tok(dark, '--hf-ink'), muted: tok(dark, '--hf-muted'), paper: tok(dark, '--hf-paper'), soft: tok(dark, '--hf-soft'), bg: tok(dark, '--hf-bg'), red: tok(darkDk, '--dk-red'), green: tok(darkDk, '--dk-green'), surface: [25, 43, 66, 0.72] } };
  const results = {};
  for (const [theme, t] of Object.entries(T)) {
    const surfaceOnBg = over(t.surface, hex(t.bg)), surfaceOnPaper = over(t.surface, hex(t.paper));
    for (const [label, fg, bg] of [['ink/paper', t.ink, hex(t.paper)], ['muted/paper', t.muted, hex(t.paper)], ['muted/soft', t.muted, hex(t.soft)], ['ink/soft', t.ink, hex(t.soft)],
      ['ink/surface', t.ink, surfaceOnBg], ['muted/surface', t.muted, surfaceOnBg], ['muted/surface-on-paper', t.muted, surfaceOnPaper],
      ['error/paper', t.red, hex(t.paper)], ['error/soft', t.red, hex(t.soft)], ['ok/surface', t.green, surfaceOnBg]]) {
      const r = ratio(hex(fg), bg); results[theme + ' ' + label] = Math.round(r * 100) / 100; assert(r >= 4.5, `${theme} ${label} ${r.toFixed(2)}`);
    }
  }
  const inputs = { light: ['#1F1F1F', '#FFFFFF'], dark: ['#F5F5F5', '#181D24'] };
  for (const [theme, [fg, bg]] of Object.entries(inputs)) { const r = ratio(hex(fg), hex(bg)); results[theme + ' input'] = Math.round(r * 100) / 100; assert(r >= 4.5); }
  results['dark placeholder'] = Math.round(ratio(hex('#9AA6B6'), hex('#181D24')) * 100) / 100; assert(results['dark placeholder'] >= 4.5);
  const seasons = [...source.matchAll(/--accent:(#[0-9A-Fa-f]{6}); --accent-ink:(#[0-9A-Fa-f]{3,6});/g)];
  assert(seasons.length >= 8, 'season accent pairs found');
  // Light seasons pair the accent with white ink; this component darkens its own primary button by 20% in light mode.
  assert.match(css, /html:not\(\[data-theme="dark"\]\) \.cd-btn-primary[^{]*\{background:color-mix\(in srgb,var\(--accent,#315ea8\) 80%,#000\)/);
  for (const [, accent, ink] of seasons) {
    const lightPair = /^#f{3}(f{3})?$/i.test(ink), bg = lightPair ? hex(accent).map(v => v * 0.8) : hex(accent);
    const r = ratio(hex(ink), bg); results['accent ' + accent + (lightPair ? ' (darkened)' : '')] = Math.round(r * 100) / 100; assert(r >= 4.5, 'primary button ' + accent + ' ' + r.toFixed(2));
  }
  console.log('CONTRAST ' + JSON.stringify(results));
});
await test('sub-item save keeps server keys and refills them onto the sent objects (index.html)', async () => {
  const block = section('const sent = items.slice();', "showToast('✓ 子案件已儲存');");
  assert.match(block, /const cleaned = cleanItems\(items\);/);   // REPORTS-P2-D2: one shared normaliser (save + unsaved-change check)
  assert.match(section('const cleanItems = list =>', 'let v43Baseline'), /\.\.\.\(typeof it\.key === 'string' && it\.key \? \{ key: it\.key \} : \{\}\)/);
  assert.match(block, /sent\.forEach\(\(ref, i\) =>/); assert.match(block, /raw\.items\.length === sent\.length/);
  assert.match(source, /<script src="\/case-deliveries\.js\?v=[0-9a-f]{12}"><\/script>/); assert.match(source, /<link rel="stylesheet" href="\/case-deliveries\.css\?v=[0-9a-f]{12}">/);
  const order = [source.indexOf('/workbench-features.js?v='), source.indexOf('/case-deliveries.js?v=')]; assert(order[0] > 0 && order[1] > order[0], 'plugin loads after workbench-features (outermost hook)');
});
console.log(JSON.stringify({ passed, failed, browserAutomation: false, liveNetwork: false, productionWrites: 0 }));
if (failed) process.exitCode = 1;
