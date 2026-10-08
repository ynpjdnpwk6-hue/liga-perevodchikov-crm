import { getChatGPTUser } from '../../chatgpt-auth';
import { getRawDb } from '../../../db';
import { handleApplication } from '../portal-service';
import { env } from 'cloudflare:workers';
export const dynamic = 'force-dynamic';
async function handle(request:Request) {
  return handleApplication(request,await getChatGPTUser(),getRawDb,String(env.LIGA_ADMIN_EMAIL||''));
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;
