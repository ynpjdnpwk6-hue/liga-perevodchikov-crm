import { getChatGPTUser } from '../chatgpt-auth';
import { getRawDb } from '../../db';
import { getPhoneContext,readCookie } from '../api/phone-auth';
import { env } from 'cloudflare:workers';
import { htmlResponse } from '../html-response';
import html from '../crm.html?raw';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const phone=readCookie(request,'__Host-liga_session')?await getPhoneContext(request,getRawDb()):null;
  const user=await getChatGPTUser();
  const owner=!!env.LIGA_ADMIN_EMAIL&&user?.email.trim().toLowerCase()===String(env.LIGA_ADMIN_EMAIL).trim().toLowerCase();
  if(phone?phone.access.role!=='admin':!owner)return new Response(null,{status:302,headers:{Location:'/login','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}});
  return htmlResponse(html);
}
