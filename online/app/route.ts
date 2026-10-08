import { requireChatGPTUser } from './chatgpt-auth';
import html from './crm.html?raw';
import { env } from 'cloudflare:workers';

export const dynamic = 'force-dynamic';
export async function GET() {
  const user=await requireChatGPTUser('/');
  if(!env.LIGA_ADMIN_EMAIL||user.email.trim().toLowerCase()!==String(env.LIGA_ADMIN_EMAIL).trim().toLowerCase())return new Response(null,{status:302,headers:{Location:'/investigator','Cache-Control':'no-store'}});
  return new Response(html, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://chatgpt.com; base-uri 'none'; form-action 'self'"}});
}
