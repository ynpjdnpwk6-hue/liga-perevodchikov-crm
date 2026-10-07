import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleCRM } from '../app/api/service.ts';

// Execute production SQL on SQLite. The adapter mirrors the prepared/batch API;
// it is deliberately separate from production's real Cloudflare D1 binding.
function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_lowly_sentry.sql',import.meta.url),'utf8'));
  const prepare=sql=>({sql,args:[],bind(...args){this.args=args;return this;},async first(){return sqlite.prepare(this.sql).get(...this.args)||null;},async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}});
  const db={prepare,async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>{
    if(/^SELECT\b/i.test(s.sql))return {results:sqlite.prepare(s.sql).all(...s.args),meta:{changes:0}};
    const meta=sqlite.prepare(s.sql).run(...s.args);return {results:[],meta:{changes:Number(meta.changes),last_row_id:Number(meta.lastInsertRowid)}};
  });sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const user={userId:'qa-owner',displayName:'Учебный администратор'};
  let csrf='',cookie='';
  async function request(path,method='GET',data,options={}) {
    const headers={'Content-Type':'application/json','Origin':'https://crm.test','Cookie':cookie,'X-CSRF-Token':csrf,...options.headers};
    const response=await handleCRM(new Request('https://crm.test'+path,{method,headers,...(data!==undefined?{body:JSON.stringify(data)}:{})}),options.user===undefined?user:options.user,()=>db);
    const result=response.headers.get('Content-Type')?.includes('application/json')?await response.json():await response.text();
    return {status:response.status,result,headers:response.headers};
  }
  return {db,sqlite,request,async login(){const response=await request('/api/session');assert.equal(response.status,200);csrf=response.result.csrf;cookie=response.headers.get('Set-Cookie').split(';')[0];return response;},close(){sqlite.close();}};
}
async function records(f){await f.login();const customer=await f.request('/api/customers','POST',{name:'Учебный заказчик'});const translator=await f.request('/api/translators','POST',{name:'Учебный переводчик',languages:['Арабский','Английский'],active:true});assert.equal(customer.status,201);assert.equal(translator.status,201);return {customer:customer.result.id,translator:translator.result.id};}

test('authenticated access, CSRF, same origin and owner isolation',async()=>{
  const f=fixture();try{
    assert.equal((await f.request('/api/data','GET',undefined,{user:null})).status,401);
    const session=await f.login();assert.match(session.headers.get('Set-Cookie'),/HttpOnly.*SameSite=Strict.*Secure/);
    assert.equal((await f.request('/api/customers','POST',{name:'Пример'},{headers:{'X-CSRF-Token':''}})).status,403);
    assert.equal((await f.request('/api/customers','POST',{name:'Пример'},{headers:{'Origin':'https://other.test'}})).status,403);
    const c=await f.request('/api/customers','POST',{name:'Учебный заказчик'});
    const other={userId:'qa-other',displayName:'Другой пользователь'};
    assert.equal((await f.request('/api/data','GET',undefined,{user:other})).result.customers.length,0);
    assert.equal((await f.request('/api/orders','POST',{customer_id:c.result.id,language:'Арабский',amount:'100'},{user:other})).status,400);
    assert.equal((await f.request(`/api/customers/${c.result.id}`,'PATCH',{name:'Правка',revision:1},{user:other})).status,404);
  }finally{f.close();}
});
test('order lifecycle, exact commission, settlement and stale revision',async()=>{
  const f=fixture();try{
    const {customer,translator}=await records(f);
    const order=await f.request('/api/orders','POST',{customer_id:customer,language:'Арабский',amount:'1000.05'});assert.equal(order.status,201);
    const path='/api/orders/'+order.result.id;
    assert.equal((await f.request(path,'PATCH',{revision:1,translator_id:translator,status:'assigned'})).status,200);
    assert.equal((await f.request(path,'PATCH',{revision:1,notes:'Устаревшая правка'})).status,409);
    assert.equal((await f.request('/api/data')).result.summary.commission,0);
    assert.equal((await f.request(path,'PATCH',{revision:2,status:'completed',commission_paid:'100'})).status,200);
    let data=(await f.request('/api/data')).result;
    assert.deepEqual(data.summary,{active:0,revenue:100005,commission:30002,commission_due:20002});
    assert.equal(data.orders[0].translator_share,70003);
    assert.equal((await f.request(path,'PATCH',{revision:3,commission_paid:'300.02'})).status,200);
    data=(await f.request('/api/data')).result;assert.equal(data.summary.commission_due,0);
    assert.equal((await f.request(path,'PATCH',{revision:4,status:'cancelled'})).status,400);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) as n FROM audit').get().n,6);
  }finally{f.close();}
});
test('language, active assignments, invalid money/date and historical settlement',async()=>{
  const f=fixture();try{
    const {customer,translator}=await records(f);
    const valid={customer_id:customer,language:'Арабский',amount:'8000'};
    for(const changes of [{amount:'-1'},{amount:'NaN'},{amount:'0.001'},{amount:true},{customer_id:true},{translator_id:false},{status:'completed'},{status:'assigned',translator_id:translator,language:'Китайский'},{scheduled_at:'2026-02-30T12:00'},{commission_paid:'1'}])assert.equal((await f.request('/api/orders','POST',{...valid,...changes})).status,400,JSON.stringify(changes));
    const order=await f.request('/api/orders','POST',{...valid,translator_id:translator,status:'assigned'});assert.equal(order.status,201);
    assert.equal((await f.request(`/api/translators/${translator}`,'PATCH',{revision:1,name:'Учебный переводчик',languages:['Английский'],active:false})).status,400);
    assert.equal((await f.request(`/api/orders/${order.result.id}`,'PATCH',{revision:1,status:'completed'})).status,200);
    assert.equal((await f.request(`/api/translators/${translator}`,'PATCH',{revision:1,name:'Учебный переводчик',languages:['Английский'],active:false})).status,200);
    assert.equal((await f.request(`/api/orders/${order.result.id}`,'PATCH',{revision:2,commission_paid:'2400'})).status,200);
    assert.equal((await f.request('/api/orders','POST',{...valid,translator_id:translator,status:'assigned'})).status,400);
  }finally{f.close();}
});
test('CSV escaping and schema storage constraints',async()=>{
  const f=fixture();try{
    const {customer,translator}=await records(f);
    await f.request(`/api/customers/${customer}`,'PATCH',{revision:1,name:'=FORMULA("x")',organization:'Организация; учебная'});
    await f.request('/api/orders','POST',{customer_id:customer,translator_id:translator,status:'completed',language:'Арабский',amount:'100'});
    const csv=await f.request('/api/export');assert.equal(csv.status,200);assert.match(csv.result,/'=FORMULA/);assert.match(csv.result,/"Организация; учебная"/);assert.match(csv.result,/"100.00";"30.00";"0.00";"30.00"/);
    assert.throws(()=>f.sqlite.prepare('UPDATE orders SET amount=-1').run(),/CHECK/);
    assert.throws(()=>f.sqlite.prepare('UPDATE orders SET commission_percent=10').run(),/CHECK/);
  }finally{f.close();}
});
