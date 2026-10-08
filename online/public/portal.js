'use strict';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={new:'Новая',assigned:'Переводчик назначен',in_progress:'В работе',completed:'Выполнена',cancelled:'Отменена'};
let csrf='',preview=false;
async function api(path,method='GET',body) {
  const response=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error||'Не удалось выполнить действие.');error.status=response.status;throw error;}
  return data;
}
function scheduled(value){if(!value)return 'Дата не указана';const [day,clock]=value.split('T');return day.split('-').reverse().join('.')+' · '+clock;}
function history(orders) {
  $('#request-count').textContent=orders.length;
  $('#portal-orders').innerHTML=orders.length?orders.map(o=>`<article class="portal-order"><div class="portal-order-top"><div><span class="order-number">ЗАЯВКА #${String(o.id).padStart(4,'0')}</span><h3>${escape(o.language)}</h3></div><span class="pill ${escape(o.status)}">${escape(labels[o.status]||o.status)}</span></div><div class="portal-order-meta"><span>${escape(scheduled(o.scheduled_at))} · Москва</span><span>${escape(o.location)}</span></div>${o.notes?`<details><summary>Комментарий к заявке</summary><p class="order-notes">${escape(o.notes)}</p></details>`:''}</article>`).join(''):`<div class="empty"><span class="empty-symbol" aria-hidden="true">▤</span><h3>У вас пока нет заявок</h3><p>${preview?'После отправки здесь появятся номер обращения и его статус.':'Отправьте первую заявку с помощью формы выше. Она появится здесь сразу после сохранения.'}</p></div>`;
}
async function reload() {
  const data=await api('/api/portal');preview=data.preview;
  $('#portal-preview').hidden=!preview;
  const profile=data.profile;
  $('#profile-name').textContent=profile?.name||'ФИО из карточки заказчика';
  $('#profile-organization').textContent=profile?.organization||'Организация не указана';
  $('#profile-phone').textContent=profile?.phone||'Телефон не указан';
  $('#request-submit').disabled=preview;
  $('#request-submit').textContent=preview?'Отправка отключена в предпросмотре':'Отправить заявку →';
  history(data.orders);$('#history-error').textContent='';
}
function accessError(error) {
  $('#portal-workspace').hidden=true;$('#portal-message').hidden=false;
  $('#portal-message').innerHTML=`<h2>${error.status===401?'Войдите в кабинет':error.status===403?'Доступ ещё не предоставлен':'Не удалось загрузить кабинет'}</h2><p>${escape(error.message)}</p>${error.status===401?'<a class="button primary" href="/signin-with-chatgpt?return_to=%2Finvestigator" target="_top">Войти через ChatGPT</a>':'<button class="button secondary" id="retry-access">Повторить</button>'}`;
  $('#retry-access')?.addEventListener('click',initialize);
}
async function initialize() {
  try{const session=await api('/api/session');csrf=session.csrf;$('#portal-username').textContent=session.username;await reload();$('#portal-message').hidden=true;$('#portal-workspace').hidden=false;}
  catch(error){accessError(error);}
}
$('#refresh-orders').addEventListener('click',async()=>{
  const button=$('#refresh-orders');button.disabled=true;
  try{await reload();}catch(error){if(error.status===401||error.status===403)accessError(error);else $('#history-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#request-form').addEventListener('submit',async event=>{
  event.preventDefault();if(preview)return;
  const button=$('#request-submit');button.disabled=true;$('#request-error').textContent='';$('#request-success').hidden=true;
  try{
    const result=await api('/api/portal/orders','POST',Object.fromEntries(new FormData(event.target)));
    event.target.reset();$('#request-success').textContent=`Заявка #${String(result.id).padStart(4,'0')} отправлена в Лигу.`;$('#request-success').hidden=false;
    // A refresh failure must not imply that a successfully saved request was lost.
    try{await reload();}catch(error){$('#history-error').textContent='Заявка сохранена. Не удалось обновить список; нажмите «Обновить».';}
  }catch(error){if(error.status===401||error.status===403)accessError(error);else $('#request-error').textContent=error.message;}
  finally{button.disabled=preview;}
});
initialize();
