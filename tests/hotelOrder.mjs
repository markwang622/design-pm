import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=process.env.DESIGN_PM_ROOT||new URL('../',import.meta.url).pathname;
const source=fs.readFileSync(root+'/public/index.html','utf8');
const feature=fs.readFileSync(root+'/public/workbench-features.js','utf8');
const section=(start,end,text=source)=>{const a=text.indexOf(start),b=text.indexOf(end,a);assert(a>=0&&b>a,start+' found');return text.slice(a,b);};
const ordering=section('let HOTEL_ORDER =','// v4.7: REQUEST_UNITS');
const loader=section('async function v37LoadHotels() {','// ── v9.9 館別統一排序');
const renderer=section('function renderGantt() {','function openDrawerById(id)');
const dict=[{name:'台中',sortOrder:40,id:4,active:true},{name:'嘉義',sortOrder:30,id:3,active:false},{name:'傳藝',sortOrder:30,id:2,active:true},{name:'集團',sortOrder:10,id:1,active:true}];
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function setup(){
  const els={gantt:{innerHTML:''},'gantt-range':{},'gantt-scope':{}};
  const c={HOTELS:dict.filter(h=>h.active),CASES:[],STAFF:[],ganttScale:'week',ganttScope:'hotel',SCALE_CFG:{week:{}},TODAY:new Date('2026-10-22'),expandedProjects:new Set(),
    document:{getElementById:id=>els[id]},ganttWindow:()=>({windowStart:new Date('2026-10-01'),windowEnd:new Date('2026-11-01'),totalDays:31}),ganttTicks:()=>[{days:31,label:'October'}],pad:n=>String(n).padStart(2,'0'),isHoliday:()=>false,isWeekend:()=>false,ymd:()=>'',v51StageInfo:()=>({color:'#777',name:'設計中'}),escapeHtml:esc,console:{warn(){}},fetchJson:async()=>dict};
  c.window=c;vm.createContext(c);vm.runInContext(ordering+'\n'+loader+'\n'+renderer+'\nHOTEL_ORDER=v99BuildHotelOrder('+JSON.stringify(dict)+');',c);
  return {c,els};
}
const makeCase=(hotel,designer,id)=>({hotel,designer,id,name:id,status:'doing',open:new Date('2026-10-02'),goLive:new Date('2026-10-28'),items:[],collaborators:[]});
const names=html=>[...html.matchAll(/class="g-label"><span>(.*?)<\/span>/g)].map(m=>m[1]);
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
await test('Gantt hotel groups follow saved order including inactive hotels, with stable id ties',()=>{
 const {c,els}=setup();c.CASES=['台中','傳藝','集團','嘉義'].map((h,i)=>makeCase(h,'Zoe','case-'+i));c.renderGantt();assert.deepEqual(names(els.gantt.innerHTML),['集團','傳藝','嘉義','台中']);
});
await test('unknown and empty hotel groups remain visible after known hotels without losing cases',()=>{
 const {c,els}=setup();c.CASES=['未知館','','台中','集團'].map((h,i)=>makeCase(h,'Zoe','case-'+i));c.renderGantt();const result=names(els.gantt.innerHTML);assert.deepEqual(result.slice(0,2),['集團','台中']);assert.equal(result.length,4);assert(result.includes('未知館'));assert.equal((els.gantt.innerHTML.match(/class="gantt-row"/g)||[]).length,4);
});
await test('reloading the saved hotel dictionary changes Gantt immediately and retains project expansion',async()=>{
 const {c,els}=setup();c.CASES=[makeCase('集團','Zoe','parent'),makeCase('台中','Amy','other')];c.CASES[0].items=[{n:'子案件'}];c.expandedProjects.add('parent');c.fetchJson=async()=>dict.map(h=>({...h,sortOrder:50-h.sortOrder}));await c.v37LoadHotels();c.renderGantt();assert.deepEqual(names(els.gantt.innerHTML),['台中','集團']);assert.match(els.gantt.innerHTML,/子案件/);assert(c.expandedProjects.has('parent'));
});
await test('designer groups retain their prior alphabetical order and exclude administrator groups',()=>{
 const {c,els}=setup();c.ganttScope='designer';c.STAFF=[{name:'Admin',role:'admin'}];c.CASES=[makeCase('集團','Zoe','z'),makeCase('台中','Amy','a'),makeCase('集團','Admin','admin')];c.renderGantt();assert.deepEqual(names(els.gantt.innerHTML),['Amy','Zoe']);assert(!els.gantt.innerHTML.includes('openDrawerById(\'admin\')'));
});
await test('dictionary sorting does not mutate the source hotel objects or array',()=>{
 const {c}=setup();c.testRows=structuredClone(dict);const before=JSON.stringify(c.testRows);vm.runInContext('v99BuildHotelOrder(testRows)',c);assert.equal(JSON.stringify(c.testRows),before);
});
await test('all-case and period ledgers share the admin hotel order while retaining a zero-result selection',()=>{
 const {c}=setup();vm.runInContext('const esc=escapeHtml;\n'+section('  const statuses =','  function ensureExplorer()',feature),c);
 const subs=new Map();const root={innerHTML:'',querySelector(selector){if(!subs.has(selector))subs.set(selector,{innerHTML:'',textContent:''});return subs.get(selector);},querySelectorAll:()=>[]};
 c.ledger(root,dict.map((h,i)=>({hotel:h.name,id:String(i),status:'doing',title:'案'+i})),{hotel:'已選但無案件'},'all');const select=root.innerHTML.match(/data-filter="hotel">(.*?)<\/select>/s)[1];assert.deepEqual([...select.matchAll(/<option value="([^"]*)"/g)].map(m=>m[1]),['','集團','傳藝','嘉義','台中','已選但無案件']);assert.match(select,/value="已選但無案件" selected/);assert.match(subs.get('[data-count]').textContent,/顯示 0 \/ 4/);
});
await test('hotel reload keeps the shared object array and derives active options from the same full catalog',async()=>{
 const {c}=setup();const ref=c.HOTELS;c.fetchJson=async()=>dict;await c.v37LoadHotels();assert.equal(c.HOTELS,ref);assert.deepEqual(c.HOTELS.map(h=>h.name),dict.filter(h=>h.active).map(h=>h.name));assert(c.HOTELS.every(h=>h.name&&typeof h==='object'));assert(c.hotelOrderCompare('嘉義','台中')<0);
});
await test('an empty successful catalog clears defaults and ranks without retaining stale hotels',async()=>{
 const {c}=setup();c.fetchJson=async()=>[];await c.v37LoadHotels();assert.equal(c.HOTELS.length,0);assert.equal(c.hotelRank('集團'),Infinity);
});
await test('a failed catalog request retains the last successfully loaded order and active options',async()=>{
 const {c}=setup();const before=JSON.stringify(c.HOTELS);c.fetchJson=async()=>{throw Error('offline');};await c.v37LoadHotels();assert.equal(JSON.stringify(c.HOTELS),before);assert(c.hotelOrderCompare('集團','台中')<0);
});
await test('a malformed catalog payload cannot wipe existing options or the saved order',async()=>{
 const {c}=setup();const before=JSON.stringify(c.HOTELS);c.fetchJson=async()=>({unexpected:true});await c.v37LoadHotels();assert.equal(JSON.stringify(c.HOTELS),before);assert(c.hotelOrderCompare('集團','台中')<0);
});
await test('history hotel filter preserves inactive selection and refreshes after a saved order change',async()=>{
 const {c}=setup();vm.runInContext(section('function v60FillHistoryHotels(sel)', 'function v60EnsureHistoryControls()'),c);c.V59_HISTORY=[{hotel:'嘉義'},{hotel:'舊館'}];const sel={value:'嘉義',innerHTML:''};c.v60FillHistoryHotels(sel);assert.equal(sel.value,'嘉義');assert.deepEqual([...sel.innerHTML.matchAll(/option value="([^"]*)"/g)].map(m=>m[1]),['','集團','傳藝','嘉義','台中','舊館']);c.fetchJson=async()=>dict.map(h=>({...h,sortOrder:50-h.sortOrder}));await c.v37LoadHotels();c.v60FillHistoryHotels(sel);assert.equal(sel.value,'嘉義');assert.deepEqual([...sel.innerHTML.matchAll(/option value="([^"]*)"/g)].map(m=>m[1]),['','台中','傳藝','嘉義','集團','舊館']);
});
await test('kanban hotel filter keeps existing inactive cases and clears only an unavailable selection',async()=>{
 const {c,els}=setup();els['kb-filter-designer']={};els['kb-filter-hotel']={};c.kbFilterDes='all';c.kbFilterHotel='嘉義';c.activeDesigners=()=>[];c.CASES=[makeCase('嘉義','Amy','one')];vm.runInContext(section('function renderKanban() {','  const kb =')+'\n}',c);c.renderKanban();assert.equal(els['kb-filter-hotel'].value,'嘉義');assert.deepEqual([...els['kb-filter-hotel'].innerHTML.matchAll(/option value="([^"]*)"/g)].map(m=>m[1]),['all','集團','傳藝','嘉義','台中']);c.kbFilterHotel='不存在';c.renderKanban();assert.equal(c.kbFilterHotel,'all');assert.equal(els['kb-filter-hotel'].value,'all');
});
console.log(JSON.stringify({passed,liveNetwork:false,caseWrites:0,hotelWrites:0}));
