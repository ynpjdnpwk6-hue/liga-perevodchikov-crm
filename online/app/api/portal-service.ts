import { handleCRM } from './service.ts';
import { resolveAccess, type Identity, type Access } from './access.ts';

const json=(value:any,status=200,headers:Record<string,string>={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
class InputError extends Error {}
function text(data:any,key:string,required=false,max=500) {
  const value=data[key]??'';
  if(typeof value!=='string'||value.length>max||required&&!value.trim())throw new InputError(`Проверьте поле: ${key}.`);
  return value.trim();
}
function date(value:string) {
  const parsed=new Date(value+'Z');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,16)!==value)throw new InputError('Укажите корректные дату и время по Москве.');
  return value;
}
async function body(request:Request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new InputError('Ожидается JSON.');
  const raw=await request.text();if(raw.length>65536)throw new InputError('Слишком большой запрос.');
  let data:any;try{data=JSON.parse(raw);}catch{throw new InputError('Некорректный запрос.');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new InputError('Ожидается объект JSON.');
  return data;
}
function csrfValid(request:Request) {
  const cookie=request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('liga_csrf='))?.slice(10);
  return request.headers.get('Origin')===new URL(request.url).origin&&!!cookie&&cookie===request.headers.get('X-CSRF-Token');
}
async function accounts(db:D1Database,owner:string) {
  return (await db.prepare('SELECT a.id,a.email,a.customer_id,a.active,a.revision,a.created_at,c.name,c.organization,c.phone FROM investigator_accounts a JOIN customers c ON c.id=a.customer_id AND c.owner_id=a.owner_id WHERE a.owner_id=? ORDER BY c.name,a.id').bind(owner).all()).results;
}
async function manageAccount(request:Request,db:D1Database,access:Access,actor:string,itemId:number|null) {
  const data=await body(request);
  const existing=itemId?await db.prepare('SELECT * FROM investigator_accounts WHERE id=? AND owner_id=?').bind(itemId,access.ownerId).first<any>():null;
  if(itemId&&!existing)return json({error:'Учётная запись не найдена.'},404);
  if(existing&&data.revision!==existing.revision)return json({error:'Доступ уже изменён. Обновите страницу.'},409);
  const email=text(data,'email',true,254).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new InputError('Укажите email аккаунта ChatGPT.');
  if(!Number.isSafeInteger(data.customer_id)||data.customer_id<1)throw new InputError('Выберите карточку заказчика.');
  if(existing&&(email!==existing.email||data.customer_id!==existing.customer_id))throw new InputError('Email и связанная карточка не меняются. Создайте отдельный доступ.');
  const active=data.active??true;if(typeof active!=='boolean')throw new InputError('Проверьте статус доступа.');
  if(!await db.prepare('SELECT id FROM customers WHERE id=? AND owner_id=?').bind(data.customer_id,access.ownerId).first())throw new InputError('Выберите заказчика из вашей базы.');
  const duplicate=await db.prepare('SELECT id FROM investigator_accounts WHERE owner_id=? AND email=?').bind(access.ownerId,email).first<any>();
  if(duplicate&&duplicate.id!==itemId)return json({error:'Доступ для этого email уже создан.'},409);
  const time=new Date().toISOString();
  const statement=existing?
    db.prepare('UPDATE investigator_accounts SET active=?,revision=revision+1 WHERE id=? AND owner_id=? AND revision=?').bind(active?1:0,itemId,access.ownerId,existing.revision):
    db.prepare('INSERT INTO investigator_accounts(owner_id,email,customer_id,active,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM investigator_accounts WHERE owner_id=? AND email=?) AND EXISTS (SELECT 1 FROM customers WHERE id=? AND owner_id=?)').bind(access.ownerId,email,data.customer_id,active?1:0,time,access.ownerId,email,data.customer_id,access.ownerId);
  const audit=db.prepare(`INSERT INTO audit(owner_id,actor_id,action,entity,entity_id,created_at) SELECT ?,?,?,'investigator_accounts',${existing?'?':'last_insert_rowid()'},? WHERE changes()>0`).bind(access.ownerId,actor,request.method,...(existing?[itemId]:[]),time);
  const result=await db.batch([statement,audit]);
  if(!result[0].meta.changes)return json({error:'Доступ уже изменён или создан. Обновите страницу.'},409);
  return json({id:itemId||result[0].meta.last_row_id},existing?200:201);
}
async function submit(request:Request,db:D1Database,access:Access,user:Identity) {
  const data=await body(request);
  const allowed=['language','scheduled_at','location','notes'];
  if(Object.keys(data).some(key=>!allowed.includes(key)))throw new InputError('Заявка содержит недопустимые поля.');
  const language=text(data,'language',true,80),scheduled=date(text(data,'scheduled_at',true,30)),location=text(data,'location',true,300),notes=text(data,'notes',false,5000),time=new Date().toISOString();
  const statement=db.prepare("INSERT INTO orders(owner_id,customer_id,requester_account_id,language,scheduled_at,location,requester_notes,status,amount,commission_paid,created_at,updated_at) SELECT owner_id,customer_id,id,?,?,?,?,'new',0,0,?,? FROM investigator_accounts WHERE id=? AND owner_id=? AND user_id=? AND active=1").bind(language,scheduled,location,notes,time,time,access.account.id,access.ownerId,user.userId);
  const audit=db.prepare("INSERT INTO audit(owner_id,actor_id,action,entity,entity_id,created_at) SELECT ?,?,'SUBMIT','orders',last_insert_rowid(),? WHERE changes()>0").bind(access.ownerId,user.userId,time);
  const result=await db.batch([statement,audit]);
  if(!result[0].meta.changes)return json({error:'Доступ к подаче заявок отключён.'},403);
  return json({id:result[0].meta.last_row_id},201);
}
export async function handleApplication(request:Request,user:Identity|null,getDb:()=>D1Database,adminEmail:string) {
  try {
    if(!user)return json({error:'Войдите через ChatGPT.'},401);
    const db=getDb(),access=await resolveAccess(db,user,adminEmail);
    if(!access)return json({error:'Доступ не предоставлен. Обратитесь к администратору Лиги и сообщите email вашего аккаунта ChatGPT.'},403);
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/api/session') {
      const csrf=crypto.randomUUID()+crypto.randomUUID();
      return json({username:user.displayName,role:access.role,csrf},200,{'Set-Cookie':`liga_csrf=${csrf}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200`});
    }
    if(request.method!=='GET'&&!csrfValid(request))return json({error:'Обновите страницу и повторите действие.'},403);
    if(path==='/api/portal'&&request.method==='GET') {
      if(access.role==='admin')return json({preview:true,profile:null,orders:[]});
      const orders=await db.prepare('SELECT id,language,scheduled_at,location,requester_notes AS notes,status,created_at,updated_at FROM orders WHERE owner_id=? AND requester_account_id=? ORDER BY id DESC').bind(access.ownerId,access.account.id).all();
      return json({preview:false,profile:access.account,orders:orders.results});
    }
    if(access.role==='investigator') {
      if(path==='/api/portal/orders'&&request.method==='POST')return await submit(request,db,access,user);
      return json({error:'Это действие доступно только администратору.'},403);
    }
    if(path.startsWith('/api/portal'))return json({error:'Предпросмотр не отправляет реальные заявки.'},403);
    if(path==='/api/data'&&request.method==='GET') {
      const response=await handleCRM(request,{...user,userId:access.ownerId},()=>db);
      if(!response.ok)return response;
      const snapshot=await response.json() as Record<string,unknown>;
      return json({...snapshot,investigators:await accounts(db,access.ownerId)});
    }
    const match=/^\/api\/investigators(?:\/([1-9]\d*))?$/.exec(path);
    if(match&&((request.method==='POST'&&!match[1])||(request.method==='PATCH'&&match[1])))return await manageAccount(request,db,access,user.userId,match[1]?Number(match[1]):null);
    return await handleCRM(request,{...user,userId:access.ownerId},()=>db);
  }catch(error) {
    if(error instanceof InputError)return json({error:error.message},400);
    console.error('Portal operation failed',error instanceof Error?error.name:'StorageError');
    return json({error:'Не удалось выполнить действие. Попробуйте ещё раз.'},503);
  }
}
