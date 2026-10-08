import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { type Access, type Identity, resolveAccess, PENDING_OWNER } from './access.ts';

const SESSION_COOKIE='__Host-liga_session';
const TTL=12*60*60*1000;
const json=(value:any,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'}});
class InputError extends Error {}
function token(){return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');}
const sha=async(value:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function readCookie(request:Request,name:string){return request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)||'';}
export function validCSRF(request:Request){const csrf=readCookie(request,'liga_csrf');return request.headers.get('Origin')===new URL(request.url).origin&&!!csrf&&equal(csrf,request.headers.get('X-CSRF-Token')||'');}
export function sessionResponse(value:any,status=200,sessionToken?:string){
  const csrf=token(),response=json({...value,csrf},status);
  response.headers.append('Set-Cookie',`liga_csrf=${csrf}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  if(sessionToken)response.headers.append('Set-Cookie',`${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  return response;
}
export function normalizePhone(value:any){
  if(typeof value!=='string'||value.length>40||!/^[+\d\s()-]+$/.test(value))throw new InputError('Укажите номер телефона в международном формате, например +7 900 123-45-67.');
  let digits=value.replace(/\D/g,'');
  if(digits.length===11&&digits[0]==='8')digits='7'+digits.slice(1);
  if(digits.length===10&&!value.trim().startsWith('+'))digits='7'+digits;
  if(!/^[1-9]\d{7,14}$/.test(digits))throw new InputError('Проверьте номер телефона.');
  return '+'+digits;
}
function field(data:any,key:string,required=false,max=150){const value=data[key]??'';if(typeof value!=='string'||value.length>max||required&&!value.trim())throw new InputError(`Проверьте поле: ${key}.`);return value.trim();}
function password(value:any){if(typeof value!=='string'||value.length<12||value.length>128||!value.trim())throw new InputError('Пароль должен содержать от 12 до 128 символов.');return value;}
function derive(value:string,salt:string){return new Promise<string>((resolve,reject)=>pbkdf2(value,salt,600000,32,'sha256',(err,key)=>err?reject(err):resolve(key.toString('hex'))));}
export async function passwordHash(value:string){const salt=token();return `pbkdf2-sha256$600000$${salt}$${await derive(value,salt)}`;}
async function verify(value:string,encoded:string){const parts=encoded.split('$');if(parts[0]!=='pbkdf2-sha256'||parts[1]!=='600000'||parts.length!==4)return false;return equal(await derive(value,parts[2]),parts[3]);}
async function body(request:Request){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new InputError('Ожидается JSON.');const raw=await request.text();if(raw.length>16000)throw new InputError('Слишком большой запрос.');let data:any;try{data=JSON.parse(raw);}catch{throw new InputError('Некорректный запрос.');}if(!data||typeof data!=='object'||Array.isArray(data))throw new InputError('Некорректный запрос.');return data;}
async function limit(db:D1Database,key:string,max:number,period:number){
  const time=Date.now(),start=Math.floor(time/period)*period;
  const digest=await sha(key);
  await db.batch([db.prepare('INSERT INTO auth_limits(key,window_start,attempts,expires_at) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,window_start=excluded.window_start,expires_at=excluded.expires_at').bind(digest,start,start+period)]);
  const row=await db.prepare('SELECT attempts FROM auth_limits WHERE key=?').bind(digest).first<any>();return row.attempts<=max;
}
async function throttle(db:D1Database,request:Request,action:string,phone:string){
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  return await limit(db,'global:'+action,300,60*60*1000)&&await limit(db,'ip:'+action+':'+ip,action==='register'?10:30,15*60*1000)&&await limit(db,'phone:'+action+':'+phone,action==='register'?3:8,15*60*1000);
}
export type PhoneContext={identity:Identity;access:Access;accountId:string};
export async function getPhoneContext(request:Request,db:D1Database):Promise<PhoneContext|null>{
  const raw=readCookie(request,SESSION_COOKIE);if(!/^[A-Za-z0-9_-]{43}$/.test(raw))return null;
  const row=await db.prepare('SELECT a.id,a.owner_id,a.role,a.customer_id,a.phone,c.name,c.organization FROM phone_sessions s JOIN phone_accounts a ON a.id=s.account_id JOIN customers c ON c.id=a.customer_id AND c.owner_id=a.owner_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=1').bind(await sha(raw),Date.now()).first<any>();
  if(!row)return null;
  return {identity:{userId:'phone:'+row.id,displayName:row.name,email:''},accountId:row.id,access:{role:row.role,ownerId:row.owner_id,account:{id:row.id,kind:'phone',customer_id:row.customer_id,name:row.name,organization:row.organization,phone:row.phone}}};
}
async function newSession(db:D1Database,accountId:string,request:Request){
  const raw=token(),old=readCookie(request,SESSION_COOKIE),time=Date.now();
  await db.batch([db.prepare('DELETE FROM phone_sessions WHERE expires_at<=? OR token_hash=?').bind(time,await sha(old)),db.prepare('DELETE FROM auth_limits WHERE expires_at<=?').bind(time),db.prepare('INSERT INTO phone_sessions(token_hash,account_id,created_at,expires_at) SELECT ?,id,?,? FROM phone_accounts WHERE id=? AND active=1').bind(await sha(raw),time,time+TTL,accountId)]);
  return raw;
}
async function createAccount(db:D1Database,data:any,role:'admin'|'investigator',ownerId?:string){
  const phone=normalizePhone(data.phone),pass=password(data.password),name=field(data,'name',true),organization=field(data,'organization',false,200);
  const existing=await db.prepare('SELECT id FROM phone_accounts WHERE phone=?').bind(phone).first();
  if(existing)return json({error:'Этот номер уже зарегистрирован. Войдите или восстановите пароль.'},409);
  const hash=await passwordHash(pass),recovery=token(),id=crypto.randomUUID(),time=new Date().toISOString();
  const owner=ownerId||((await db.prepare('SELECT owner_id FROM league WHERE id=1').first<any>())?.owner_id??PENDING_OWNER);
  const result=await db.batch([
    db.prepare('INSERT INTO customers(owner_id,name,organization,phone) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM phone_accounts WHERE phone=?)').bind(owner,name,organization,phone,phone),
    db.prepare('INSERT INTO phone_accounts(id,owner_id,customer_id,phone,password_hash,recovery_hash,role,created_at) SELECT ?,?,last_insert_rowid(),?,?,?,?,? WHERE changes()>0').bind(id,owner,phone,hash,await sha(recovery),role,time),
    db.prepare("INSERT INTO audit(owner_id,actor_id,action,entity,entity_id,created_at) SELECT owner_id,?,'REGISTER','customers',customer_id,? FROM phone_accounts WHERE id=? AND changes()>0").bind('phone:'+id,time,id)
  ]);
  if(!result[1].meta.changes)return json({error:'Этот номер уже зарегистрирован.'},409);
  return {id,recoveryCode:recovery,role};
}
export async function handlePhoneAuth(request:Request,db:D1Database,platformUser:Identity|null,adminEmail:string):Promise<Response|null>{
  const path=new URL(request.url).pathname;
  if(!path.startsWith('/api/auth/'))return null;
  try{
    if(path==='/api/auth/session'&&request.method==='GET'){
      const context=await getPhoneContext(request,db);return sessionResponse({authenticated:!!context,role:context?.access.role??null,username:context?.identity.displayName??null});
    }
    if(request.method!=='POST')return json({error:'Действие не найдено.'},404);
    if(!validCSRF(request))return json({error:'Обновите страницу и повторите действие.'},403);
    if(path==='/api/auth/logout'){
      await db.batch([db.prepare('DELETE FROM phone_sessions WHERE token_hash=?').bind(await sha(readCookie(request,SESSION_COOKIE)))]);
      const response=json({ok:true});response.headers.append('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);response.headers.append('Set-Cookie','liga_csrf=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');return response;
    }
    const data=await body(request),phone=normalizePhone(data.phone);
    if(!await throttle(db,request,path.slice(10),phone))return json({error:'Слишком много попыток. Попробуйте через 15 минут.'},429);
    if(path==='/api/auth/register'){
      if(data.consent!==true)throw new InputError('Подтвердите ознакомление с обработкой данных.');
      if(data.password!==data.confirm_password)throw new InputError('Пароли не совпадают.');
      const result=await createAccount(db,data,'investigator');if(result instanceof Response)return result;
      return sessionResponse({role:result.role,recoveryCode:result.recoveryCode},201,await newSession(db,result.id,request));
    }
    if(path==='/api/auth/login'){
      const pass=password(data.password),account=await db.prepare('SELECT * FROM phone_accounts WHERE phone=?').bind(phone).first<any>();
      // Unknown accounts perform the same expensive derivation as real ones.
      const encoded=account?.password_hash??'pbkdf2-sha256$600000$unknown-account-salt$'+ '0'.repeat(64);
      if(!await verify(pass,encoded)||!account||!account.active)return json({error:'Неверный номер или пароль либо доступ отключён.'},401);
      return sessionResponse({role:account.role},200,await newSession(db,account.id,request));
    }
    if(path==='/api/auth/recover'){
      const pass=password(data.password);if(data.password!==data.confirm_password)throw new InputError('Пароли не совпадают.');
      const recovery=field(data,'recovery_code',true,100),oldHash=await sha(recovery),account=await db.prepare('SELECT * FROM phone_accounts WHERE phone=? AND active=1').bind(phone).first<any>();
      if(!account||!equal(account.recovery_hash,oldHash))return json({error:'Неверный номер или код восстановления.'},401);
      const replacement=token(),hash=await passwordHash(pass);
      const result=await db.batch([db.prepare('UPDATE phone_accounts SET password_hash=?,recovery_hash=?,revision=revision+1 WHERE id=? AND recovery_hash=? AND active=1').bind(hash,await sha(replacement),account.id,oldHash),db.prepare('DELETE FROM phone_sessions WHERE account_id=? AND changes()>0').bind(account.id)]);
      if(!result[0].meta.changes)return json({error:'Код уже использован. Повторите вход.'},409);
      return sessionResponse({role:account.role,recoveryCode:replacement},200,await newSession(db,account.id,request));
    }
    if(path==='/api/auth/admin-phone'){
      const phoneContext=await getPhoneContext(request,db);
      const access=phoneContext?.access.role==='admin'?phoneContext.access:platformUser?await resolveAccess(db,platformUser,adminEmail):null;
      if(access?.role!=='admin')return json({error:'Настройка доступна только владельцу CRM.'},403);
      const configured=await db.prepare("SELECT phone FROM phone_accounts WHERE owner_id=? AND role='admin'").bind(access.ownerId).first<any>();
      if(configured)return json({error:'Вход владельца по телефону уже настроен. Для смены пароля используйте личный код восстановления.'},409);
      if(data.password!==data.confirm_password)throw new InputError('Пароли не совпадают.');
      const existing=await db.prepare('SELECT * FROM phone_accounts WHERE phone=?').bind(phone).first<any>();
      if(existing){
        if(existing.owner_id!==access.ownerId||!existing.active||!await verify(password(data.password),existing.password_hash))return json({error:'Номер уже занят. Укажите пароль существующей учётной записи или другой номер.'},409);
        await db.batch([db.prepare("UPDATE phone_accounts SET role='admin',revision=revision+1 WHERE id=? AND role='investigator'").bind(existing.id),db.prepare("INSERT INTO audit(owner_id,actor_id,action,entity,entity_id,created_at) VALUES(?,?,'ADMIN_PHONE','customers',?,?)").bind(access.ownerId,platformUser?.userId??phoneContext!.identity.userId,existing.customer_id,new Date().toISOString())]);
        return json({ok:true});
      }
      const result=await createAccount(db,{...data,name:'Администратор Лиги',organization:''},'admin',access.ownerId);if(result instanceof Response)return result;
      return json({ok:true,recoveryCode:result.recoveryCode},201);
    }
    return json({error:'Действие не найдено.'},404);
  }catch(error){
    if(error instanceof InputError)return json({error:error.message},400);
    console.error('Phone authentication failed',error instanceof Error?error.name:'StorageError');return json({error:'Не удалось выполнить действие. Попробуйте ещё раз.'},503);
  }
}
