import { createHash } from 'node:crypto';
export const SITE_ORIGIN='https://liga-perevodchikov-crm.silky-globe-7217.chatgpt.site';
export function htmlResponse(html:string,isPublic=false){
  const hashes=[...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m=>`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':isPublic?'public, max-age=300':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Robots-Tag':isPublic?'index, follow':'noindex, nofollow','Content-Security-Policy':`default-src 'self'; script-src 'self' ${hashes}; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://chatgpt.com; base-uri 'none'; form-action 'self'`}});
}
