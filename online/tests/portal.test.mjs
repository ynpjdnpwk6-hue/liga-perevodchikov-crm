import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handleApplication } from '../app/api/portal-service.ts';

const admin={userId:'owner',email:'owner@example.test',displayName:'Администратор'};
const alice={userId:'alice',email:'alice@example.test',displayName:'Следователь А'};
const bob={userId:'bob',email:'bob@example.test',displayName:'Следователь Б'};
const valid={language:'Арабский',scheduled_at:'2026-10-20T12:30',location:'Учебный адрес',notes:'Учебная заявка'};
function fixture() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
  const prepare=sql=>({sql,args:[],bind(...args){this.args=args;return this;},async first(){return sqlite.prepare(this.sql).get(...this.args)||null;},async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}});
  const db={prepare,async batch(statements){sqlite.exec('BEGIN');try{
    const results=statements.map(s=>{if(/^SELECT\b/i.test(s.sql))return {results:sqlite.prepare(s.sql).all(...s.args),meta:{changes:0}};const m=sqlite.prepare(s.sql).run(...s.args);return {results:[],meta:{changes:Number(m.changes),last_row_id:Number(m.lastInsertRowid)}};});sqlite.exec('COMMIT');return results;
  }catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const sessions=new Map();
  async function request(user,path,method='GET',data,options={}) {
    const session=sessions.get(user?.userId)||{};
    const headers={'Content-Type':'application/json','Origin':'https://crm.test','Cookie':session.cookie||'','X-CSRF-Token':session.csrf||'',...options.headers};
    const response=await handleApplication(new Request('https://crm.test'+path,{method,headers,...(data!==undefined?{body:JSON.stringify(data)}:{})}),user,()=>db,options.adminEmail??admin.email);
    const result=response.headers.get('Content-Type')?.includes('application/json')?await response.json():await response.text();
    if(path==='/api/session'&&response.ok)sessions.set(user.userId,{csrf:result.csrf,cookie:response.headers.get('Set-Cookie').split(';')[0]});
    return {status:response.status,result,headers:response.headers};
  }
  async function setup() {
    assert.equal((await request(admin,'/api/session')).status,200);
    const c=await request(admin,'/api/customers','POST',{name:'Учебный следователь',organization:'Учебная организация',phone:'+7 учебный'});
    assert.equal(c.status,201);
    const a=await request(admin,'/api/investigators','POST',{email:alice.email,customer_id:c.result.id});assert.equal(a.status,201);
    const b=await request(admin,'/api/investigators','POST',{email:bob.email,customer_id:c.result.id});assert.equal(b.status,201);
    assert.equal((await request(alice,'/api/session')).result.role,'investigator');assert.equal((await request(bob,'/api/session')).result.role,'investigator');
    return {customer:c.result.id,a:a.result.id,b:b.result.id};
  }
  return {sqlite,request,setup,close:()=>sqlite.close()};
}

test('only configured owner can initialize the league; unknown and alternate identities are denied',async()=>{
  const f=fixture();try{
    assert.equal((await f.request(null,'/api/session')).status,401);
    assert.equal((await f.request(alice,'/api/session')).status,403);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM league').get().n,0);
    assert.equal((await f.request(admin,'/api/session','GET',undefined,{adminEmail:''})).status,403);
    assert.equal((await f.request(admin,'/api/session')).result.role,'admin');
    assert.equal((await f.request({...admin,userId:'other-owner-id'},'/api/data')).status,403);
    assert.equal((await f.request({...admin,email:alice.email},'/api/data')).status,403);
  }finally{f.close();}
});
test('investigator submissions enter shared CRM; only own requests and public statuses are returned',async()=>{
  const f=fixture();try{
    const {customer,a}=await f.setup();
    const saved=await f.request(alice,'/api/portal/orders','POST',valid);assert.equal(saved.status,201);
    const adminData=(await f.request(admin,'/api/data')).result;
    assert.equal(adminData.orders.length,1);assert.equal(adminData.orders[0].customer_id,customer);assert.equal(adminData.orders[0].requester_account_id,a);
    assert.equal(adminData.orders[0].owner_id,undefined);assert.equal(adminData.orders[0].amount,0);assert.equal(adminData.orders[0].translator_id,null);assert.equal(adminData.investigators.length,2);
    assert.equal(f.sqlite.prepare("SELECT actor_id FROM audit WHERE action='SUBMIT'").get().actor_id,alice.userId);
    const translator=await f.request(admin,'/api/translators','POST',{name:'Учебный переводчик',phone:'Секретный телефон',languages:['Арабский']});assert.equal(translator.status,201);
    assert.equal((await f.request(admin,'/api/orders/'+saved.result.id,'PATCH',{revision:1,translator_id:translator.result.id,status:'assigned',amount:'1000',notes:'Внутренняя финансовая заметка'})).status,200);
    const portal=(await f.request(alice,'/api/portal')).result;
    assert.equal(portal.orders.length,1);assert.equal(portal.orders[0].status,'assigned');assert.equal(portal.profile.name,'Учебный следователь');
    assert.deepEqual(Object.keys(portal.orders[0]).sort(),['created_at','id','language','location','notes','scheduled_at','status','updated_at'].sort());
    assert.equal(JSON.stringify(portal).includes('Секретный телефон'),false);
    assert.equal(portal.orders[0].notes,valid.notes);assert.equal(JSON.stringify(portal).includes('Внутренняя финансовая заметка'),false);
    assert.equal((await f.request(bob,'/api/portal')).result.orders.length,0,'same customer does not grant access to another account’s requests');
    const preview=(await f.request(admin,'/api/portal')).result;assert.equal(preview.preview,true);assert.deepEqual(preview.orders,[]);
    assert.equal((await f.request(admin,'/api/portal/orders','POST',valid)).status,403);
  }finally{f.close();}
});
test('investigators cannot use administrative endpoints or forge ownership, assignment and money',async()=>{
  const f=fixture();try{
    await f.setup();
    for(const path of ['/api/data','/api/export','/api/translators','/api/customers','/api/orders/1','/api/investigators'])assert.equal((await f.request(alice,path)).status,403,path);
    for(const path of ['/api/orders','/api/customers','/api/translators','/api/investigators'])assert.equal((await f.request(alice,path,'POST',{name:'Попытка'})).status,403,path);
    assert.equal((await f.request(alice,'/api/orders/1','PATCH',{status:'completed',revision:1})).status,403);
    for(const forged of [{owner_id:'bob'},{customer_id:99},{requester_account_id:2},{amount:'1000'},{commission_paid:'100'},{status:'completed'},{translator_id:1}])assert.equal((await f.request(alice,'/api/portal/orders','POST',{...valid,...forged})).status,400);
    assert.equal((await f.request(alice,'/api/portal/orders','POST',valid,{headers:{Origin:'https://other.test'}})).status,403);
    assert.equal((await f.request(alice,'/api/portal/orders','POST',valid,{headers:{'X-CSRF-Token':''}})).status,403);
    for(const invalid of [{scheduled_at:'2026-02-30T12:00'},{scheduled_at:''},{language:''},{location:''},{notes:42},{language:'А'.repeat(81)}])assert.equal((await f.request(alice,'/api/portal/orders','POST',{...valid,...invalid})).status,400);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
    assert.equal((await f.request({...alice,userId:'another-identity'},'/api/portal')).status,403);
  }finally{f.close();}
});
test('account deactivation blocks all portal access and preserves history; duplicate and stale edits rejected',async()=>{
  const f=fixture();try{
    const {customer,a}=await f.setup();assert.equal((await f.request(alice,'/api/portal/orders','POST',valid)).status,201);
    assert.equal((await f.request(admin,'/api/investigators','POST',{email:alice.email.toUpperCase(),customer_id:customer})).status,409);
    assert.equal((await f.request(admin,'/api/investigators','POST',{email:'bad',customer_id:customer})).status,400);
    assert.equal((await f.request(admin,'/api/investigators','POST',{email:'new@example.test',customer_id:9999})).status,400);
    assert.equal((await f.request(admin,'/api/investigators/'+a,'PATCH',{email:alice.email,customer_id:customer,active:false,revision:1})).status,200);
    assert.equal((await f.request(admin,'/api/investigators/'+a,'PATCH',{email:alice.email,customer_id:customer,active:true,revision:1})).status,409);
    assert.equal((await f.request(alice,'/api/portal')).status,403);assert.equal((await f.request(alice,'/api/portal/orders','POST',valid)).status,403);
    assert.equal((await f.request(admin,'/api/data')).result.orders.length,1);
    assert.equal((await f.request(admin,'/api/investigators/'+a,'PATCH',{email:alice.email,customer_id:customer,active:true,revision:2})).status,200);
    assert.equal((await f.request(alice,'/api/portal')).result.orders.length,1);
  }finally{f.close();}
});
test('migration preserves existing orders and customer records',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('PRAGMA foreign_keys=ON');db.exec(readFileSync(new URL('../drizzle/0000_lowly_sentry.sql',import.meta.url),'utf8'));
    db.prepare('INSERT INTO customers(owner_id,name) VALUES(?,?)').run(admin.userId,'Существующий заказчик');
    db.prepare("INSERT INTO orders(owner_id,customer_id,language,created_at,updated_at,amount) VALUES(?,1,'Арабский','before','before',12345)").run(admin.userId);
    for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')&&!n.startsWith('0000')).sort())db.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
    const order=db.prepare('SELECT * FROM orders').get();assert.equal(order.amount,12345);assert.equal(order.requester_account_id,null);assert.equal(order.owner_id,admin.userId);
    assert.equal(db.prepare('SELECT name FROM customers').get().name,'Существующий заказчик');
  }finally{db.close();}
});
