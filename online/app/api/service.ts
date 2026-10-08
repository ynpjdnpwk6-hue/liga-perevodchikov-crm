const statuses=['new','assigned','in_progress','completed','cancelled'];
const entities=['customers','translators','orders'];
class InputError extends Error {}
const fee=(amount:number)=>Math.floor((amount*30+50)/100);
const now=()=>new Date().toISOString();
const normalize=(value:string)=>value.trim().toLocaleLowerCase('ru');
function str(data:any,key:string,required=false,limit=500) {
  const value=data[key]??'';
  if(typeof value!=='string'||value.length>limit)throw new InputError(`Проверьте поле: ${key}.`);
  if(required&&!value.trim())throw new InputError(`Заполните поле: ${key}.`);
  return value.trim();
}
function id(value:any) {if(!Number.isSafeInteger(value)||value<1)throw new InputError('Некорректный идентификатор записи.');return value;}
function money(value:any) {
  if(!['string','number'].includes(typeof value))throw new InputError('Некорректная сумма.');
  const match=/^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/.exec(String(value));
  if(!match)throw new InputError('Укажите неотрицательную сумму с точностью до копейки.');
  const minor=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
  if(minor>10000000000)throw new InputError('Сумма не должна превышать 100 000 000 ₽.');
  return minor;
}
function json(value:any,status=200,headers:Record<string,string>={}) {
  return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow',...headers}});
}
function cookie(request:Request) {return request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('liga_csrf='))?.slice(10)||'';}
function enrich(row:any) {
  const commission=fee(row.amount);
  return {...row,commission,translator_share:row.amount-commission,commission_due:row.status==='completed'?commission-row.commission_paid:0};
}
async function snapshot(db:D1Database,owner:string) {
  const results=await db.batch([
    db.prepare('SELECT id,name,phone,languages,active,revision FROM translators WHERE owner_id=? ORDER BY name').bind(owner),
    db.prepare('SELECT id,name,organization,phone,revision FROM customers WHERE owner_id=? ORDER BY name').bind(owner),
    db.prepare('SELECT o.*,c.name AS customer_name,c.organization,t.name AS translator_name FROM orders o JOIN customers c ON c.id=o.customer_id AND c.owner_id=o.owner_id LEFT JOIN translators t ON t.id=o.translator_id AND t.owner_id=o.owner_id WHERE o.owner_id=? ORDER BY o.id DESC').bind(owner),
  ]);
  const translators=results[0].results.map((r:any)=>({...r,languages:JSON.parse(r.languages),active:!!r.active}));
  const orders=results[2].results.map((r:any)=>{const {owner_id,...record}=r;return enrich(record);});
  const completed=orders.filter(o=>o.status==='completed');
  return {translators,customers:results[1].results,orders,summary:{active:orders.filter(o=>!['completed','cancelled'].includes(o.status)).length,revenue:completed.reduce((s,o)=>s+o.amount,0),commission:completed.reduce((s,o)=>s+o.commission,0),commission_due:completed.reduce((s,o)=>s+o.commission_due,0)}};
}
async function mutate(db:D1Database,owner:string,method:string,entity:string,itemId:number|null,data:any) {
  const existing=itemId?await db.prepare(`SELECT * FROM ${entity} WHERE id=? AND owner_id=?`).bind(itemId,owner).first<any>():null;
  if(itemId&&!existing)return json({error:'Запись не найдена.'},404);
  if(existing&&data.revision!==existing.revision)return json({error:'Запись уже изменена. Обновите страницу и повторите.'},409);
  let values:Record<string,any>={};
  let guard='1=1';let guardArgs:any[]=[];
  if(entity==='customers') {
    values={name:str(data,'name',true,150),organization:str(data,'organization',false,200),phone:str(data,'phone',false,80)};
  }else if(entity==='translators') {
    if(!Array.isArray(data.languages)||!data.languages.length||data.languages.length>30||data.languages.some((v:any)=>typeof v!=='string'||!v.trim()||v.length>80))throw new InputError('Укажите хотя бы один язык.');
    const active=data.active??true;if(typeof active!=='boolean')throw new InputError('Проверьте статус переводчика.');
    const languages=[...new Set(data.languages.map((v:string)=>v.trim()))].sort() as string[];
    values={name:str(data,'name',true,150),phone:str(data,'phone',false,80),languages:JSON.stringify(languages),language_keys:JSON.stringify(languages.map(normalize)),active:active?1:0};
    if(existing) {
      guard="NOT EXISTS (SELECT 1 FROM orders o WHERE o.translator_id=? AND o.owner_id=? AND o.status IN ('assigned','in_progress') AND (?=0 OR o.language NOT IN (SELECT value FROM json_each(?))))";
      const pending=await db.prepare("SELECT language FROM orders WHERE translator_id=? AND owner_id=? AND status IN ('assigned','in_progress')").bind(itemId,owner).all<any>();
      if(pending.results.some(r=>!active||!languages.map(normalize).includes(normalize(r.language))))throw new InputError('Сначала переназначьте активные заявки с удаляемым языком или отключаемым переводчиком.');
      // SQL guards use exact stored labels. Add existing active-order spellings for case-insensitive equivalence.
      const allowedLabels=[...languages,...pending.results.map(r=>r.language)];
      guardArgs=[itemId,owner,active?1:0,JSON.stringify(allowedLabels)];
    }
  }else {
    const merged={status:'new',amount:'0',commission_paid:'0',...existing,...data};
    if(existing&&!Object.hasOwn(data,'amount'))merged.amount=(existing.amount/100).toFixed(2);
    if(existing&&!Object.hasOwn(data,'commission_paid'))merged.commission_paid=(existing.commission_paid/100).toFixed(2);
    const customer=id(merged.customer_id);
    if(!await db.prepare('SELECT id FROM customers WHERE id=? AND owner_id=?').bind(customer,owner).first())throw new InputError('Выберите заказчика из базы.');
    const language=str(merged,'language',true,80);const status=merged.status;
    if(!statuses.includes(status))throw new InputError('Некорректный статус заявки.');
    const translator=merged.translator_id??null;
    const historical=existing&&['completed','cancelled'].includes(status)&&translator===existing.translator_id&&language===existing.language;
    if(translator!==null) {
      id(translator);
      const person=await db.prepare('SELECT * FROM translators WHERE id=? AND owner_id=?').bind(translator,owner).first<any>();
      if(!person||(!historical&&(!person.active||!JSON.parse(person.language_keys).includes(normalize(language)))))throw new InputError('Выберите активного переводчика с нужным языком.');
      if(!historical) {guard="EXISTS (SELECT 1 FROM translators t WHERE t.id=? AND t.owner_id=? AND t.active=1 AND EXISTS (SELECT 1 FROM json_each(t.language_keys) WHERE value=?))";guardArgs=[translator,owner,normalize(language)];}
    }
    if(['assigned','in_progress','completed'].includes(status)&&translator===null)throw new InputError('Сначала назначьте переводчика.');
    if(status==='new'&&translator!==null)throw new InputError('Для заявки с переводчиком выберите статус «Назначена».');
    const amount=money(merged.amount);const paid=money(merged.commission_paid);
    if(paid>fee(amount))throw new InputError('Полученная комиссия превышает 30% стоимости.');
    if(paid&&status!=='completed')throw new InputError('Полученную комиссию укажите после выполнения заявки.');
    const date=str(merged,'scheduled_at',false,30);
    if(date) {
      const parsed=new Date(date+'Z');
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,16)!==date)throw new InputError('Проверьте дату и время заявки.');
    }
    values={customer_id:customer,translator_id:translator,language,scheduled_at:date,location:str(merged,'location',false,300),notes:str(merged,'notes',false,5000),status,amount,commission_percent:30,commission_paid:paid,updated_at:now()};
    if(!existing)values.created_at=now();
  }
  const keys=Object.keys(values);let statement:D1PreparedStatement;
  if(existing) {
    statement=db.prepare(`UPDATE ${entity} SET ${keys.map(k=>k+'=?').join(',')},revision=revision+1 WHERE id=? AND owner_id=? AND revision=? AND (${guard})`).bind(...Object.values(values),itemId,owner,existing.revision,...guardArgs);
  }else {
    statement=db.prepare(`INSERT INTO ${entity} (owner_id,${keys.join(',')}) SELECT ${[owner,...keys].map(()=>'?').join(',')} WHERE ${guard}`).bind(owner,...Object.values(values),...guardArgs);
  }
  const audit=db.prepare(`INSERT INTO audit(owner_id,action,entity,entity_id,created_at) SELECT ?,?,?,${existing?'?':'last_insert_rowid()'},? WHERE changes()>0`).bind(owner,method,entity,...(existing?[itemId]:[]),now());
  const result=await db.batch([statement,audit]);
  if(!result[0].meta.changes)return json({error:'Связанная запись уже изменилась. Обновите страницу и повторите.'},409);
  return json({id:itemId||result[0].meta.last_row_id},existing?200:201);
}
export async function handleCRM(request:Request,user:{userId:string,displayName:string}|null,getDb:()=>D1Database) {
  try {
    if(!user)return json({error:'Войдите через ChatGPT.'},401);
    const pathname=new URL(request.url).pathname;
    if(request.method==='GET'&&pathname==='/api/session') {
      const csrf=crypto.randomUUID()+crypto.randomUUID();
      return json({username:user.displayName,csrf},200,{'Set-Cookie':`liga_csrf=${csrf}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200`});
    }
    if(request.method!=='GET') {
      if(request.headers.get('Origin')!==new URL(request.url).origin)return json({error:'Недопустимый источник запроса.'},403);
      const csrf=cookie(request);
      if(!csrf||csrf!==request.headers.get('X-CSRF-Token'))return json({error:'Обновите страницу и повторите действие.'},403);
    }
    const db=getDb();
    if(request.method==='GET'&&pathname==='/api/data')return json(await snapshot(db,user.userId));
    if(request.method==='GET'&&pathname==='/api/export') {
      const data=await snapshot(db,user.userId);
      const safe=(value:any)=>{let v=String(value??'');if(/^[\s]*[=+\-@]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
      const rows=[['Номер','Заказчик','Организация','Язык','Переводчик','Дата (Москва)','Статус','Стоимость, ₽','Комиссия, ₽','Получено, ₽','Долг, ₽'],...data.orders.map(o=>[o.id,o.customer_name,o.organization,o.language,o.translator_name,o.scheduled_at,o.status,(o.amount/100).toFixed(2),(o.commission/100).toFixed(2),(o.commission_paid/100).toFixed(2),(o.commission_due/100).toFixed(2)])];
      return new Response('\ufeff'+rows.map(r=>r.map(safe).join(';')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="liga-orders.csv"','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}});
    }
    const match=/^\/api\/(customers|translators|orders)(?:\/([1-9]\d*))?$/.exec(pathname);
    if(!match||!entities.includes(match[1])||!((request.method==='POST'&&!match[2])||(request.method==='PATCH'&&match[2])))return json({error:'Действие не найдено.'},404);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new InputError('Ожидается JSON.');
    const raw=await request.text();if(raw.length>65536)throw new InputError('Слишком большой запрос.');
    let data:any;try{data=JSON.parse(raw);}catch{throw new InputError('Некорректный запрос.');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw new InputError('Ожидается объект JSON.');
    return await mutate(db,user.userId,request.method,match[1],match[2]?id(Number(match[2])):null,data);
  }catch(error) {
    if(error instanceof InputError)return json({error:error.message},400);
    console.error('CRM operation failed',error instanceof Error?error.name:'StorageError');
    return json({error:'Не удалось выполнить действие. Попробуйте ещё раз.'},503);
  }
}

