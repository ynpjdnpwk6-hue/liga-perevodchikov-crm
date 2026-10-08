'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rub = kopecks => new Intl.NumberFormat('ru-RU', {style:'currency',currency:'RUB',maximumFractionDigits:kopecks % 100 ? 2 : 0}).format(kopecks / 100);
const labels = {new:'Новая',assigned:'Назначена',in_progress:'В работе',completed:'Выполнена',cancelled:'Отменена'};
const pages = {
  dashboard:['Обзор','Обзор работы','Все заявки и финансы — перед глазами.','＋ Новая заявка'],
  orders:['Заявки','Заявки','От первого обращения до выполненного перевода.','＋ Новая заявка'],
  translators:['Переводчики','База переводчиков','Языки, контакты и назначенные заявки.','＋ Переводчик'],
  customers:['Заказчики','Заказчики','Контакты и история обращений в Лигу.','＋ Заказчик'],
  investigators:['Следователи','Доступ следователям','Учётные записи и доступ к личному кабинету.','＋ Следователь'],
  finance:['Финансы','Финансы','Комиссия Лиги и расчёты с переводчиками.','＋ Новая заявка']
};
let state = {view:'dashboard',data:null,csrf:'',username:''};
let editor = null;
let toastTimer;

async function api(path, method='GET', body) {
  const response = await fetch(path, {method,credentials:'same-origin',headers: {'Content-Type':'application/json',...(state.csrf ? {'X-CSRF-Token':state.csrf} : {})},...(body ? {body:JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(result.error || 'Не удалось выполнить действие.');
  }
  return result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function showLogin() { state.csrf = ''; state.data = null; $('#workspace').hidden = true; $('#login-view').hidden = false; if ($('#editor').open) $('#editor').close(); }
async function openWorkspace(session) {
  if(session.role==='investigator'){window.location.assign('/investigator');return;}
  state.csrf = session.csrf; state.username = session.username;
  $('#account-name').textContent = session.username; $('#login-view').hidden = true; $('#workspace').hidden = false;
  $('#today').textContent = new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'}).format(new Date());
  await reload();
}
async function reload() {
  try { state.data = await api('/api/data'); render(); }
  catch (error) { $('#page-content').innerHTML = `<div class="panel empty"><h3>Не удалось загрузить данные</h3><p>${escape(error.message)}</p><button class="button secondary" data-action="retry">Повторить</button></div>`; }
}
function setView(view) { if (!pages[view]) return; state.view = view; render(); }
function pill(status) { return `<span class="pill ${escape(status)}">${escape(labels[status] || status)}</span>`; }
function empty(title, description, type) { return `<div class="empty"><h3>${escape(title)}</h3><p>${escape(description)}</p>${type ? `<button class="button secondary" data-create="${type}">Добавить ${type === 'orders' ? 'заявку' : type === 'customers' ? 'заказчика' : type === 'investigators' ? 'следователя' : 'переводчика'}</button>` : ''}</div>`; }
function stats() {
  const s = state.data.summary;
  return `<div class="stats">${[
    ['Активные заявки',String(s.active),'Новые, назначенные и в работе','▤',''],
    ['Стоимость услуг',rub(s.revenue),'По выполненным заявкам','↗',''],
    ['Комиссия Лиги',rub(s.commission),'30% от стоимости услуг','₽',''],
    ['К получению',rub(s.commission_due),'Остаток комиссии от переводчиков','↙','emphasis']
  ].map(([title,value,note,symbol,cls])=>`<div class="stat ${cls}"><div class="stat-head">${title}<span class="stat-symbol">${symbol}</span></div><strong class="stat-value">${value}</strong><span class="stat-note">${note}</span></div>`).join('')}</div>`;
}
function scheduled(value) { if (!value) return 'Дата не указана'; const [day,clock] = value.split('T'); return `${day.split('-').reverse().join('.')} · ${clock}`; }
function ordersTable(orders, finance=false) {
  if (!orders.length) return empty(finance ? 'Пока нет выполненных заявок' : 'Заявок пока нет',finance ? 'После выполнения заявки здесь появятся комиссия, полученная сумма и остаток долга.' : 'Добавьте заказчика и создайте первую заявку. Все изменения сохраняются в базе.',finance ? null : 'orders');
  return `<div class="table-wrap"><table><thead><tr><th>Заявка / заказчик</th><th>Язык / переводчик</th>${finance ? '<th>Стоимость</th><th>Комиссия 30%</th><th>Получено</th><th>Долг</th>' : '<th>Статус</th><th>Стоимость</th><th>Дата</th>'}</tr></thead><tbody>${orders.map(o=>`<tr><td><button class="order-link" data-edit="orders" data-id="${o.id}">#${String(o.id).padStart(4,'0')}</button><strong>${escape(o.customer_name)}</strong><small>${escape(o.organization)}</small>${o.requester_account_id?'<small>Из кабинета следователя</small>':''}</td><td><strong>${escape(o.language)}</strong><small>${escape(o.translator_name || 'Не назначен')}</small></td>${finance ? `<td>${rub(o.amount)}</td><td>${rub(o.commission)}</td><td>${rub(o.commission_paid)}</td><td><strong>${rub(o.commission_due)}</strong></td>` : `<td>${pill(o.status)}</td><td>${rub(o.amount)}</td><td class="muted">${escape(scheduled(o.scheduled_at))}</td>`}</tr>`).join('')}</tbody></table></div>`;
}
function dashboard() {
  const active = state.data.translators.filter(t=>t.active);
  const counts = new Map(); active.forEach(t=>t.languages.forEach(l=>counts.set(l,(counts.get(l)||0)+1)));
  const languages = [...counts].sort((a,b)=>b[1]-a[1]).slice(0,5);
  return `${stats()}<div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h3>Последние заявки</h3><p>Текущие обращения и выполненные переводы</p></div><button class="text-button" data-view="orders">Все заявки →</button></div>${ordersTable(state.data.orders.slice(0,6))}</section><div class="right-panels"><section class="panel"><div class="panel-head"><div><h3>Языки в базе</h3><p>${active.length} активных переводчиков</p></div><span class="stat-symbol">◎</span></div>${languages.length ? languages.map(([l,c])=>`<div class="mini-row"><strong>${escape(l)}</strong><span class="count">${c}</span></div>`).join('') : empty('Добавьте переводчиков','Здесь появятся доступные языки.','translators')}</section><section class="finance-note"><span class="eyebrow">ПРОЗРАЧНЫЕ РАСЧЁТЫ</span><h3>Лиге — 30%</h3><p>Переводчику остаётся 70% стоимости. Фиксируйте полученную комиссию, чтобы видеть задолженность.</p></section></div></div>`;
}
function render() {
  const page = pages[state.view];
  $('#breadcrumb-view').textContent = page[0]; $('#page-title').textContent = page[1]; $('#page-subtitle').textContent = page[2]; $('#add-main').textContent = page[3];
  document.querySelectorAll('.sidebar [data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view === state.view));
  if (!state.data) return;
  $('#nav-count').textContent = state.data.summary.active;
  if (state.view === 'dashboard') { $('#page-content').innerHTML = dashboard(); return; }
  if (state.view === 'finance') {
    $('#page-content').innerHTML = `${stats()}<p class="finance-info">В сводке учтены только выполненные заявки. «Стоимость услуг» — сумма по заявкам, а «К получению» — ещё не перечисленная Лиге комиссия.</p><section class="panel"><div class="panel-head"><h3>Расчёты по заявкам</h3><a class="button secondary" href="/api/export" download>↓ Скачать CSV</a></div>${ordersTable(state.data.orders.filter(o=>o.status==='completed'),true)}</section>`; return;
  }
  $('#page-content').innerHTML = `${state.view==='investigators'?`<div class="investigator-note"><p>Свяжите email аккаунта ChatGPT с карточкой заказчика. Следователь сможет отправлять заявки и видеть только свои обращения. Для первого входа также нужно приглашение на закрытый сайт; добавление записи здесь не отправляет письмо.</p><a class="button secondary" href="/investigator">Посмотреть кабинет следователя →</a></div>`:''}<div class="toolbar"><input id="search" type="search" placeholder="${state.view === 'orders' ? 'Номер, заказчик, язык…' : 'Поиск по базе…'}" aria-label="Поиск">${state.view === 'orders' ? `<select id="status-filter" aria-label="Статус заявки"><option value="">Все статусы</option>${Object.entries(labels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><a class="button secondary" href="/api/export" download>↓ CSV</a>` : ''}</div><div id="list-results"></div>`;
  $('#search').addEventListener('input',renderResults); $('#status-filter')?.addEventListener('change',renderResults); renderResults();
}
function renderResults() {
  const q = $('#search').value.trim().toLocaleLowerCase('ru');
  let rows = state.data[state.view].filter(r=>Object.values(r).flat().join(' ').toLocaleLowerCase('ru').includes(q));
  if (state.view === 'orders') {
    const status = $('#status-filter').value;
    if (status) rows = rows.filter(r=>r.status === status);
    $('#list-results').innerHTML = `<section class="panel">${rows.length ? ordersTable(rows) : q || status ? empty('Ничего не найдено','Попробуйте изменить поиск или фильтр.') : ordersTable([])}</section>`; return;
  }
  if(state.view==='investigators'){
    $('#list-results').innerHTML=rows.length?`<div class="cards-grid">${rows.map(r=>`<article class="person-card"><div class="person-card-top"><span class="tag">Следователь</span><span class="pill ${r.active?'completed':'cancelled'}">${r.active?'Доступ включён':'Доступ отключён'}</span></div><h3>${escape(r.name)}</h3><p>${escape(r.organization||'Организация не указана')}</p><p class="account-email">${escape(r.email)}</p><div class="card-bottom"><span>${state.data.orders.filter(o=>o.requester_account_id===r.id).length} заявок</span><button class="text-button" data-edit="investigators" data-id="${r.id}">Изменить доступ →</button></div></article>`).join('')}</div>`:`<section class="panel">${empty(q?'Ничего не найдено':'Подключите первого следователя',q?'Измените поисковый запрос.':'Сначала создайте карточку в разделе «Заказчики», затем добавьте email для доступа.',q?null:'investigators')}</section>`;return;
  }
  if (!rows.length) { $('#list-results').innerHTML = `<section class="panel">${empty(q ? 'Ничего не найдено' : state.view === 'customers' ? 'Добавьте первого заказчика' : 'Добавьте первого переводчика',q ? 'Попробуйте изменить поисковый запрос.' : 'Создайте карточку, чтобы использовать её в заявках.',q ? null : state.view)}</section>`; return; }
  $('#list-results').innerHTML = `<div class="cards-grid">${rows.map(r=>{
    const isTranslator = state.view === 'translators';
    const orders = state.data.orders.filter(o=>isTranslator ? o.translator_id === r.id : o.customer_id === r.id);
    return `<article class="person-card"><div class="person-card-top"><span class="avatar">${escape(r.name.split(/\s+/).slice(0,2).map(v=>v[0]).join(''))}</span>${isTranslator ? `<span class="pill ${r.active?'completed':'cancelled'}">${r.active?'Активен':'Неактивен'}</span>` : '<span class="tag">Заказчик</span>'}</div><h3>${escape(r.name)}</h3><p>${escape(isTranslator ? r.phone || 'Телефон не указан' : r.organization || 'Организация не указана')}</p>${isTranslator ? `<div class="tags">${r.languages.map(l=>`<span class="tag">${escape(l)}</span>`).join('')}</div>` : `<div class="tags"><span class="muted">${escape(r.phone || 'Телефон не указан')}</span></div>`}<div class="card-bottom"><span>${orders.length} заявок</span><button class="text-button" data-edit="${state.view}" data-id="${r.id}">Изменить →</button></div></article>`;
  }).join('')}</div>`;
}
function field(name,label,value='',type='text',extra='') { return `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`; }
function option(value,label,selected) { return `<option value="${escape(value)}" ${String(value)===String(selected) ? 'selected' : ''}>${escape(label)}</option>`; }
function edit(type,id) {
  const row = id ? state.data[type].find(r=>r.id===id) : null;
  if (id && !row) return;
  editor = {type,id,revision:row?.revision}; $('#editor-error').textContent = '';
  $('#editor-title').textContent = type==='investigators' ? row ? 'Доступ следователя' : 'Добавить следователя' : type === 'orders' ? row ? `Заявка #${String(id).padStart(4,'0')}` : 'Новая заявка' : type === 'customers' ? row ? 'Карточка заказчика' : 'Новый заказчик' : row ? 'Карточка переводчика' : 'Новый переводчик';
  if (['orders','investigators'].includes(type) && !state.data.customers.length) { toast('Сначала добавьте заказчика.'); edit('customers'); return; }
  const r = row || {};
  if(type==='investigators'){
    $('#editor-fields').innerHTML=`<label class="full-width">Карточка заказчика *<select name="customer_id" required ${row?'disabled':''}><option value="">Выберите заказчика</option>${state.data.customers.map(c=>option(c.id,`${c.name}${c.organization?' · '+c.organization:''}`,r.customer_id)).join('')}</select>${row?`<input type="hidden" name="customer_id" value="${r.customer_id}">`:''}<span class="field-hint">ФИО, организация и телефон берутся из этой карточки.</span></label>${field('email','Email аккаунта ChatGPT *',r.email,'email',`required maxlength="254" ${row?'readonly':''}`)}<label>Доступ<select name="active">${option('true','Включён',row?String(!!r.active):'true')}${option('false','Отключён',row?String(!!r.active):'true')}</select></label><p class="field-hint full-width">Добавление доступа не отправляет приглашение на закрытый сайт. Email и связанная карточка фиксируются при создании. Отключение блокирует кабинет, сохраняя историю заявок.</p>`;
  }else if (type === 'customers') {
    $('#editor-fields').innerHTML = `${field('name','Контактное лицо *',r.name,'text','required maxlength="150"')}${field('phone','Телефон',r.phone,'tel','maxlength="80"')}${field('organization','Организация',r.organization,'text','maxlength="200"')}`;
  } else if (type === 'translators') {
    $('#editor-fields').innerHTML = `${field('name','ФИО *',r.name,'text','required maxlength="150"')}${field('phone','Телефон',r.phone,'tel','maxlength="80"')}<label class="full-width">Языки *<input name="languages" value="${escape((r.languages || []).join(', '))}" placeholder="Например: Арабский, Английский" required maxlength="2000"><span class="field-hint">Перечислите языки через запятую.</span></label><label>Статус<select name="active">${option('true','Активен',r.active !== false)}${option('false','Неактивен',r.active === false ? 'false' : '')}</select></label>`;
  } else {
    const languages = [...new Set(state.data.translators.flatMap(t=>t.languages))].sort();
    $('#editor-fields').innerHTML = `<label>Заказчик *<select name="customer_id" required><option value="">Выберите заказчика</option>${state.data.customers.map(c=>option(c.id,`${c.name}${c.organization ? ' · '+c.organization : ''}`,r.customer_id)).join('')}</select></label><label>Язык *<input name="language" list="languages-list" value="${escape(r.language)}" required maxlength="80"><datalist id="languages-list">${languages.map(l=>option(l,l,'')).join('')}</datalist></label><label>Переводчик<select name="translator_id"></select><span class="field-hint">Показаны активные переводчики с нужным языком.</span></label><label>Статус<select name="status">${Object.entries(labels).map(([v,l])=>option(v,l,r.status||'new')).join('')}</select></label>${field('scheduled_at','Дата и время (Москва)',r.scheduled_at,'datetime-local')}${field('amount','Стоимость услуг, ₽',r.amount === undefined ? '' : (r.amount/100).toFixed(2),'number','min="0" max="100000000" step="0.01" required')}<div class="calculation full-width"><span>Комиссия Лиги · 30%<strong id="calc-commission">0 ₽</strong></span><span>Переводчику · 70%<strong id="calc-share">0 ₽</strong></span></div>${field('commission_paid','Получено комиссии, ₽',r.commission_paid === undefined ? 0 : (r.commission_paid/100).toFixed(2),'number','min="0" max="100000000" step="0.01" required')}<label>Место / адрес<input name="location" value="${escape(r.location)}" maxlength="300"></label>${r.requester_account_id?`<div class="requester-comment full-width"><strong>Комментарий следователя</strong><p>${escape(r.requester_notes||'Без комментария')}</p></div>`:''}<label class="full-width">Заметки администратора<textarea name="notes" maxlength="5000">${escape(r.notes)}</textarea><span class="field-hint">Эти заметки видны только администратору. Полученную комиссию фиксируйте после выполнения заявки.</span></label>`;
    const language = $('[name="language"]', $('#editor')); const translator = $('[name="translator_id"]', $('#editor'));
    const fillTranslators = preferred => {
      const selected = preferred || translator.value;
      const eligible = state.data.translators.filter(t=>(t.active && t.languages.some(l=>l.toLocaleLowerCase('ru')===language.value.trim().toLocaleLowerCase('ru'))) || (r.translator_id===t.id && ['completed','cancelled'].includes(r.status) && language.value===r.language));
      translator.innerHTML = option('','Не назначен','') + eligible.map(t=>option(t.id,t.name,selected)).join('');
    };
    fillTranslators(r.translator_id);
    language.addEventListener('input',()=>fillTranslators());
    translator.addEventListener('change',()=>{ const status=$('[name="status"]',$('#editor')); if (translator.value && status.value==='new') status.value='assigned'; if (!translator.value && ['assigned','in_progress'].includes(status.value)) status.value='new'; });
    $('[name="amount"]',$('#editor')).addEventListener('input',updateCalculation); updateCalculation();
  }
  if (!$('#editor').open) $('#editor').showModal();
}
function updateCalculation() {
  const amount = Math.round(Number($('[name="amount"]',$('#editor')).value || 0)*100);
  const fee = Math.round(amount*30/100);
  $('#calc-commission').textContent = rub(fee); $('#calc-share').textContent = rub(amount-fee);
}
async function logout() { window.location.assign('/signout-with-chatgpt?return_to=%2F'); }
$('#logout').addEventListener('click',logout);
$('#logout-mobile').addEventListener('click',logout);
$('#add-main').addEventListener('click',()=>{ if (state.data) edit(['customers','translators','investigators'].includes(state.view) ? state.view : 'orders'); });
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-view],[data-edit],[data-create],[data-action]'); if(!target)return;
  if(target.dataset.view)setView(target.dataset.view);
  else if(target.dataset.edit)edit(target.dataset.edit,Number(target.dataset.id));
  else if(target.dataset.create)edit(target.dataset.create);
  else if(target.dataset.action==='retry')reload();
});
$('#close-editor').addEventListener('click',()=>$('#editor').close()); $('#cancel-editor').addEventListener('click',()=>$('#editor').close());
$('#editor-form').addEventListener('submit',async event=>{
  event.preventDefault(); const button=$('[type="submit"]',event.target); button.disabled=true; $('#editor-error').textContent='';
  const data=Object.fromEntries(new FormData(event.target));
  if(editor.id) data.revision=editor.revision;
  if(editor.type==='orders') { data.customer_id=Number(data.customer_id); data.translator_id=data.translator_id ? Number(data.translator_id) : null; }
  if(editor.type==='investigators'){data.customer_id=Number(data.customer_id);data.active=data.active==='true';}
  if(editor.type==='translators') { data.languages=data.languages.split(',').map(v=>v.trim()).filter(Boolean); data.active=data.active==='true'; }
  try { await api(`/api/${editor.type}${editor.id ? '/'+editor.id : ''}`,editor.id?'PATCH':'POST',data); $('#editor').close(); toast('Сохранено'); await reload(); }
  catch(error) { $('#editor-error').textContent=error.message; } finally { button.disabled=false; }
});
(async()=>{ try { await openWorkspace(await api('/api/session')); } catch(error) { showLogin(); toast(error.message); } })();

// Agent actions share the same server validation and visible state as the UI.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = tool => {
    try { Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{}); } catch {}
  };
  register({name:'list_liga_orders',title:'Просмотреть заявки Лиги',description:'Прочитать сохранённые заявки, переводчиков и расчёты текущего пользователя.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},async execute(input){if(!input||Object.keys(input).length)throw new Error('Ожидается пустой объект.');await reload();if(!state.data)throw new Error('Данные недоступны.');return state.data;}});
  register({name:'start_liga_order_creation',title:'Открыть новую заявку',description:'Открыть форму новой заявки. Это действие не сохраняет заявку.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},async execute(input){if(!input||Object.keys(input).length)throw new Error('Ожидается пустой объект.');if(!state.data)await reload();if(!state.data)throw new Error('Данные недоступны.');setView('orders');edit('orders');return {form:editor.type,open:document.querySelector('#editor').open};}});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
