import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
process.env.DATABASE_URL='postgresql://unused:unused@127.0.0.1:1/unused';
process.env.SMTP_HOST='smtp.example.invalid';process.env.SMTP_PORT='587';
process.env.SMTP_USER='fixture@example.invalid';process.env.SMTP_PASS='synthetic-mail-test-only';
process.env.SMTP_FROM='設計團隊 <fixture@example.invalid>';
const {prisma}=await import('../src/lib/db.js');
const realCreate=nodemailer.createTransport.bind(nodemailer),messages=[],configs=[];
let failDelivery=false,recent=null,writes=0;
nodemailer.createTransport=config=>{
  configs.push(config);
  // The upgraded library compiles actual MIME; no network transport is used.
  const stream=realCreate({streamTransport:true,buffer:true,newline:'unix'});
  return {verify:async()=>true,sendMail:async mail=>{
    if(failDelivery)throw Error('synthetic SMTP failure');
    const compiled=await stream.sendMail(mail);messages.push({mail,compiled});return compiled;
  }};
};
prisma.notification.findFirst=async()=>recent;
prisma.notification.create=async({data})=>({id:++writes,...data});
prisma.staff.findUnique=async()=>({email:'recipient@example.invalid',active:true});
for(const method of ['$connect','$queryRaw','$queryRawUnsafe','$executeRaw','$executeRawUnsafe'])prisma[method]=async()=>{throw Error('Live database forbidden');};
const {deliver,notify,smtpConfigStatus,sendTestMail}=await import('../src/services/notify.js');
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
await check('upgraded Nodemailer compiles real Unicode multipart message without network',async()=>{
  assert.equal(await deliver('recipient@example.invalid','設計案件更新','第一行\nSecond line'),true);
  const {mail,compiled}=messages.at(-1),raw=compiled.message.toString();
  assert.equal(mail.to,'recipient@example.invalid');assert.equal(mail.text,'第一行\nSecond line');assert.equal(mail.html,'第一行<br>Second line');
  assert.deepEqual(compiled.envelope.to,['recipient@example.invalid']);assert(raw.includes('multipart/alternative'));assert(raw.includes('text/plain'));assert(raw.includes('text/html'));assert(raw.includes('Subject: =?UTF-8?'));
  assert.equal(configs[0].secure,false);assert.equal(configs[0].port,587);
});
await check('empty recipient is not reported as a delivered message',async()=>{
  const n=messages.length;assert.equal(await deliver('','Fixture','Body'),false);assert.equal(messages.length,n);
});
await check('ordinary notification persists then compiles with upgraded library',async()=>{
  recent=null;const n=messages.length,row=await notify({type:'fixture',recipientId:1,subject:'Fixture update',body:'First\nSecond',relatedCaseId:'Fixture-case'});
  assert.equal(row.recipientId,1);assert.equal(row.relatedCaseId,'Fixture-case');assert.equal(messages.length,n+1);
});
await check('dedupe preserves durable notification without a second email',async()=>{
  recent={id:1};const n=messages.length,before=writes;await notify({type:'fixture',recipientId:1,subject:'Fixture update',body:'Body',relatedCaseId:'Fixture-case'});
  assert.equal(writes,before+1);assert.equal(messages.length,n);
});
await check('forced retry remains compatible with upgraded transport',async()=>{
  const n=messages.length;await notify({type:'fixture',recipientId:1,subject:'Forced fixture',body:'Body',relatedCaseId:'Fixture-case',force:true});assert.equal(messages.length,n+1);
});
await check('SMTP failure preserves notification and accurately reports failed delivery',async()=>{
  failDelivery=true;assert.equal(await deliver('recipient@example.invalid','Fixture','Body'),false);
  const before=writes;const row=await notify({type:'fixture',recipientId:1,subject:'Fixture',body:'Body',force:true});assert.equal(writes,before+1);assert(row.id);failDelivery=false;
});
await check('SMTP diagnostics verify using in-memory transport and never expose password',async()=>{
  const status=smtpConfigStatus();assert.equal(status.configured,true);assert(!JSON.stringify(status).includes(process.env.SMTP_PASS));assert.notEqual(status.user,process.env.SMTP_USER);assert.equal(status.hasPass,true);assert.equal('pass' in status,false);
  const result=await sendTestMail('recipient@example.invalid');assert.equal(result.ok,true);assert(messages.length>0);
});
nodemailer.createTransport=realCreate;await prisma.$disconnect();console.log(JSON.stringify({passed,externalSMTP:false,liveDatabase:false,mimeCompiler:'real upgraded Nodemailer'}));
