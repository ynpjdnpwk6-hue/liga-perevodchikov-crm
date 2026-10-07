import { requireChatGPTUser } from './chatgpt-auth';
import html from './crm.html?raw';

export const dynamic = 'force-dynamic';
export async function GET() {
  await requireChatGPTUser('/');
  return new Response(html, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://chatgpt.com; base-uri 'none'; form-action 'self'"}});
}
