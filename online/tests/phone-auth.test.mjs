import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handleApplication } from '../app/api/portal-service.ts';

const owner={userId:'owner',email:'owner@example.test',displayName:'Владелец'};
const pass='Учебный пароль 12345';
const reg=(phone,name='Учебный следователь')=>({phone,name,organization:'Учебная организация',password:pass,confirm_password:pass,consent:true});
function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
  const prepare=sql=>({sql,args:[],bind(...args){this.args=args;return this;},async first(){return sqlite.prepare(this.sql).get(...this.args)||null;},async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}});
  const db={prepare,async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>{if(/^SELECT\b/i.test(s.sql))return {results:sqlite.prepare(s.sql).all(...s.args),meta:{changes:0}};const m=sqlite.prepare(s.sql).run(...s.args);return {results:[],meta:{changes:Number(m.changes),last_row_id:Number(m.lastInsertRowid)}};});sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  function client(user=null){
    const cookies=new Map();let csrf='';
    async function request(path,method='GET',data,options={}){
      const headers={'Content-Type':'application/json',Origin:'https://crm.test',Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'X-CSRF-Token':csrf,...options.headers};
      const response=await handleApplication(new Request('https://crm.test'+path,{method,headers,...(data!==undefined?{body:JSON.stringify(data)}:{})}),user,()=>db,owner.email);
      for(const cookie of response.headers.getSetCookie()){const [key,value]=cookie.split(';')[0].split('=');if(value)cookies.set(key,value);else cookies.delete(key);}
      const result=await response.json();if(result.csrf)csrf=result.csrf;return {status:response.status,result,headers:response.headers};
    }
    return {request,cookies,async start(){assert.equal((await request('/api/auth/session')).status,200);}};
  }
  return {sqlite,client,close:()=>sqlite.close()};
}
const order={language:'Арабский',scheduled_at:'2026-10-20T11:30',location:'Учебный адрес',notes:'Комментарий следователя'};

test('phone registration without ChatGPT creates isolated portal and preserves submissions before owner initialization',async()=>{
  const f=fixture();try{
    const a=f.client(),b=f.client(),admin=f.client(owner);await a.start();await b.start();
    const created=await a.request('/api/auth/register','POST',{...reg('8 (900) 000-00-01'),role:'admin',owner_id:'forged'});assert.equal(created.status,201);assert.equal(created.result.role,'investigator');assert.match(created.result.recoveryCode,/^[A-Za-z0-9_-]{43}$/);
    assert.equal((await a.request('/api/session')).result.authType,'phone');
    assert.equal((await a.request('/api/portal/orders','POST',order)).status,201);
    assert.equal((await b.request('/api/auth/register','POST',reg('+79000000002','Другой следователь'))).status,201);
    assert.equal((await b.request('/api/portal')).result.orders.length,0);
    for(const path of ['/api/data','/api/export','/api/orders/1'])assert.equal((await a.request(path)).status,403);
    assert.equal((await a.request('/api/orders/1','PATCH',{revision:1,status:'completed'})).status,403);
    assert.equal((await a.request('/api/portal/orders','POST',{...order,customer_id:1})).status,400);
    const raw=f.sqlite.prepare('SELECT * FROM phone_accounts WHERE phone=?').get('+79000000001');assert.notEqual(raw.password_hash,pass);assert.match(raw.password_hash,/^pbkdf2-sha256\$600000\$/);assert.notEqual(raw.recovery_hash,created.result.recoveryCode);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM league').get().n,0);
    assert.equal((await admin.request('/api/session')).status,200);
    const data=(await admin.request('/api/data')).result;assert.equal(data.orders.length,1);assert.equal(data['phone-users'].length,2);assert.equal(data.orders[0].owner_id,undefined);
    assert.equal(f.sqlite.prepare('SELECT owner_id FROM orders').get().owner_id,owner.userId);
    assert.equal((await a.request('/api/portal')).result.orders.length,1);
    assert.equal(JSON.stringify(data['phone-users']).includes('password_hash'),false);
    assert.equal((await a.request('/api/auth/admin-phone','POST',reg('+79000000001'))).status,403);
  }finally{f.close();}
});
test('login, recovery rotation, logout and session expiry do not expose passwords or permit old credentials',async()=>{
  const f=fixture();try{
    const a=f.client(),login=f.client();await a.start();await login.start();
    const created=await a.request('/api/auth/register','POST',reg('+79000000003'));assert.equal(created.status,201);
    const cookie=a.cookies.get('__Host-liga_session');assert.equal(f.sqlite.prepare('SELECT token_hash FROM phone_sessions').get().token_hash===cookie,false);
    assert.match(created.headers.getSetCookie().join(';'),/HttpOnly/);assert.match(created.headers.getSetCookie().join(';'),/Secure/);
    assert.equal((await login.request('/api/auth/login','POST',{phone:'+79000000003',password:'Неверный пароль 123'})).status,401);
    assert.equal((await login.request('/api/auth/login','POST',{phone:'+79000000003',password:pass})).status,200);
    const replacement='Новый учебный пароль 999';
    const recovered=await login.request('/api/auth/recover','POST',{phone:'+79000000003',password:replacement,confirm_password:replacement,recovery_code:created.result.recoveryCode});assert.equal(recovered.status,200);assert.notEqual(recovered.result.recoveryCode,created.result.recoveryCode);
    assert.equal((await a.request('/api/portal')).status,401,'old sessions invalidated');
    assert.equal((await a.request('/api/auth/recover','POST',{phone:'+79000000003',password:pass,confirm_password:pass,recovery_code:created.result.recoveryCode})).status,401);
    assert.equal((await a.request('/api/auth/login','POST',{phone:'+79000000003',password:pass})).status,401);
    assert.equal((await login.request('/api/auth/logout','POST',{})).status,200);assert.equal((await login.request('/api/portal')).status,401);
    assert.equal((await a.request('/api/auth/login','POST',{phone:'+79000000003',password:replacement})).status,200);
    f.sqlite.prepare('UPDATE phone_sessions SET expires_at=0').run();assert.equal((await a.request('/api/portal')).status,401);
  }finally{f.close();}
});
test('CSRF, duplicate number, invalid registration, throttling and deactivation are enforced server-side',async()=>{
  const f=fixture();try{
    const a=f.client(),admin=f.client(owner);await a.start();
    assert.equal((await a.request('/api/auth/register','POST',reg('+79000000004'),{headers:{Origin:'https://other.test'}})).status,403);
    assert.equal((await a.request('/api/auth/register','POST',reg('+79000000004'),{headers:{'X-CSRF-Token':''}})).status,403);
    assert.equal((await a.request('/api/auth/register','POST',{...reg('+79000000004'),password:'short',confirm_password:'short'})).status,400);
    assert.equal((await a.request('/api/auth/register','POST',reg('+79000000004'))).status,201);
    assert.equal((await a.request('/api/auth/register','POST',reg('89000000004'))).status,409);
    await admin.request('/api/session');const account=(await admin.request('/api/data')).result['phone-users'][0];
    assert.equal((await admin.request('/api/phone-users/'+account.id,'PATCH',{active:false,revision:account.revision})).status,200);
    assert.equal((await a.request('/api/portal')).status,401);
    assert.equal((await a.request('/api/auth/login','POST',{phone:'+79000000004',password:pass})).status,401);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM phone_sessions').get().n,0);
    assert.equal((await admin.request('/api/phone-users/'+account.id,'PATCH',{active:true,revision:account.revision})).status,409);
    const attempts=f.client();await attempts.start();let last;
    for(let i=0;i<9;i++)last=await attempts.request('/api/auth/login','POST',{phone:'+79000000005',password:pass});assert.equal(last.status,429);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM customers').get().n,1);
  }finally{f.close();}
});
test('owner can bind an administrator phone; self-registration and investigators cannot promote themselves',async()=>{
  const f=fixture();try{
    const admin=f.client(owner),phone=f.client();await admin.request('/api/session');
    const setup=await admin.request('/api/auth/admin-phone','POST',reg('+79000000006'));assert.equal(setup.status,201);assert.ok(setup.result.recoveryCode);
    await phone.start();assert.equal((await phone.request('/api/auth/login','POST',{phone:'+79000000006',password:pass})).result.role,'admin');
    assert.equal((await phone.request('/api/session')).result.role,'admin');assert.equal((await phone.request('/api/data')).status,200);
    assert.equal((await phone.request('/api/portal')).result.preview,true);
    const account=(await phone.request('/api/data')).result['phone-users'][0];assert.equal((await phone.request('/api/phone-users/'+account.id,'PATCH',{active:false,revision:1})).status,404);
    assert.equal((await admin.request('/api/auth/admin-phone','POST',reg('+79000000007'))).status,409);
  }finally{f.close();}
});
