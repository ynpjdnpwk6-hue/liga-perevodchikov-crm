'use strict';
const $=selector=>document.querySelector(selector);
let mode=new URLSearchParams(location.search).get('mode')==='register'?'register':'login',csrf='';
function input(name,label,type,autocomplete,extra=''){return `<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" ${extra} required></label>`;}
function setMode(next){
  mode=next;$('#auth-error').textContent='';$('#auth-form').reset();
  document.querySelectorAll('.auth-tabs button').forEach(b=>{b.classList.toggle('active',b.dataset.mode===mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode));});
  $('#auth-title').textContent=mode==='register'?'Создать кабинет':mode==='recover'?'Восстановить пароль':'Вход в кабинет';
  $('#auth-description').textContent=mode==='register'?'Вход по номеру и паролю. Код из SMS не отправляется.':mode==='recover'?'Понадобится личный код, выданный при регистрации.':'Введите номер и пароль, указанные при регистрации.';
  $('#auth-submit').textContent=mode==='register'?'Зарегистрироваться':mode==='recover'?'Задать новый пароль':'Войти';
  $('#auth-fields').innerHTML=`${mode==='register'?input('name','ФИО *','text','name','maxlength="150"')+'<label>Организация<input name="organization" autocomplete="organization" maxlength="200"></label>':''}${input('phone','Номер телефона *','tel','tel','maxlength="40" placeholder="+7 900 123-45-67"')}${mode==='recover'?input('recovery_code','Личный код восстановления *','text','off','maxlength="100"'):''}${input('password',mode==='recover'?'Новый пароль *':'Пароль *','password',mode==='login'?'current-password':'new-password','minlength="12" maxlength="128"')}${mode!=='login'?'<p class="field-hint">Пароль — от 12 символов. Можно использовать длинную фразу.</p>'+input('confirm_password','Повторите пароль *','password','new-password','minlength="12" maxlength="128"'):''}${mode==='register'?'<label class="auth-consent"><input name="consent" type="checkbox" required><span>Я ознакомился с <a href="/privacy" target="_blank" rel="noopener">обработкой данных</a> для регистрации и обработки моих заявок.</span></label>':''}`;
}
async function session(){const r=await fetch('/api/auth/session',{credentials:'same-origin'}),data=await r.json();if(!r.ok)throw new Error(data.error||'Не удалось открыть вход.');csrf=data.csrf;return data;}
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
$('#auth-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('#auth-submit');button.disabled=true;$('#auth-error').textContent='';
  try{
    if(!csrf)await initialSession.catch(()=>session());
    const data=Object.fromEntries(new FormData(event.target));if(mode==='register')data.consent=data.consent==='on';
    if(mode!=='login'&&data.password!==data.confirm_password)throw new Error('Пароли не совпадают.');
    const r=await fetch('/api/auth/'+mode,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)}),result=await r.json();
    if(!r.ok){if(r.status===403)await session();throw new Error(result.error||'Не удалось выполнить действие.');}
    csrf=result.csrf||csrf;const target=result.role==='admin'?'/admin':'/investigator';
    if(result.recoveryCode){$('#auth-controls').hidden=true;$('#recovery-code').textContent=result.recoveryCode;$('#continue-link').href=target;$('#recovery-result').hidden=false;$('#recovery-result').scrollIntoView({block:'start',behavior:'smooth'});}
    else location.assign(target);
  }catch(error){$('#auth-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#copy-recovery').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#recovery-code').textContent);$('#copy-status').textContent='Код скопирован. Сохраните его в надёжном месте.';}catch{$('#copy-status').textContent='Выделите и скопируйте код вручную.';}});
setMode(mode);const initialSession=session();initialSession.then(s=>{if(s.authenticated)location.replace(s.role==='admin'?'/admin':'/investigator');}).catch(error=>{$('#auth-error').textContent=error.message;});
